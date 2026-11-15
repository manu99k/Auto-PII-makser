import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  rgb,
} from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {
  BatchConfig,
  PiiOccurrence,
  ProcessedFileResult,
} from '../src/types.ts';
import {
  detectPiiInText,
  filterByConfidence,
  generateMockReplacement,
  type DetectedSpan,
} from './piiEngine.ts';

// Configure pdfjs-dist worker for Node.js environment
const workerPath = path.resolve(
  process.cwd(),
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'
);
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;

interface ExtractedTextBox {
  str: string;
  x: number;
  y: number; // bottom-left PDF coordinate
  width: number;
  height: number;
  fontSize: number;
}

interface ExtractedPage {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
  items: Array<{
    box: ExtractedTextBox;
    startOffset: number;
    endOffset: number;
  }>;
}

export async function extractPdfPages(pdfBytes: Uint8Array): Promise<ExtractedPage[]> {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBytes),
    useWorkerFetch: false,
    useSystemFonts: true,
    verbosity: 0,
  });

  const pdfDoc = await loadingTask.promise;
  const pages: ExtractedPage[] = [];

  try {
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      const page = await pdfDoc.getPage(p);
      const viewport = page.getViewport({ scale: 1.0 });
      const textContent = await page.getTextContent();

      let fullText = '';
      const mappedItems: ExtractedPage['items'] = [];
      let prevY: number | null = null;
      let prevEndX: number | null = null;

      for (const rawItem of textContent.items) {
        if (!('str' in rawItem) || typeof rawItem.str !== 'string') continue;
        const str = rawItem.str;
        if (str.length === 0) continue;

        const tx = rawItem.transform; // [scaleX, skewY, skewX, scaleY, x, y]
        const x = tx[4];
        const y = tx[5];
        const fontSize = Math.max(6, Math.hypot(tx[0], tx[1]) || rawItem.height || 10);
        const width = Math.max(rawItem.width || str.length * fontSize * 0.5, 4);
        const height = Math.max(rawItem.height || fontSize * 1.15, fontSize);

        // Insert line break or space separator so regex boundaries behave naturally
        if (fullText.length > 0) {
          if (prevY !== null && Math.abs(y - prevY) > fontSize * 0.65) {
            fullText += '\n';
          } else if (prevEndX !== null && x - prevEndX > fontSize * 0.22 && !fullText.endsWith(' ') && !str.startsWith(' ')) {
            fullText += ' ';
          }
        }

        const startOffset = fullText.length;
        fullText += str;
        const endOffset = fullText.length;

        mappedItems.push({
          box: { str, x, y, width, height, fontSize },
          startOffset,
          endOffset,
        });

        prevY = y;
        prevEndX = x + width;
      }

      pages.push({
        pageNumber: p,
        width: viewport.width,
        height: viewport.height,
        text: fullText,
        items: mappedItems,
      });
    }
  } finally {
    await loadingTask.destroy();
  }

  return pages;
}

function computeSpanBoundingBox(
  page: ExtractedPage,
  spanStart: number,
  spanEnd: number
): { x: number; y: number; width: number; height: number; fontSize: number } | null {
  const overlapping = page.items.filter(
    (item) => item.endOffset > spanStart && item.startOffset < spanEnd
  );

  if (overlapping.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let avgFont = 0;

  for (const item of overlapping) {
    const { box, startOffset, endOffset } = item;
    const itemLen = Math.max(1, endOffset - startOffset);
    const localStart = Math.max(0, spanStart - startOffset);
    const localEnd = Math.min(itemLen, spanEnd - startOffset);

    const startRatio = localStart / itemLen;
    const endRatio = localEnd / itemLen;

    const subX0 = box.x + box.width * startRatio;
    const subX1 = box.x + box.width * endRatio;

    minX = Math.min(minX, subX0);
    maxX = Math.max(maxX, subX1);
    minY = Math.min(minY, box.y - box.fontSize * 0.22);
    maxY = Math.max(maxY, box.y + box.fontSize * 0.92);
    avgFont += box.fontSize;
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(12, maxX - minX),
    height: Math.max(10, maxY - minY),
    fontSize: avgFont / overlapping.length,
  };
}

function escapePdfLiteralRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scrubStreamStrings(
  pdfDoc: PDFDocument,
  replacements: Array<{ original: string; replacement: string }>
) {
  if (replacements.length === 0) return;
  // Sort longest first so partial substrings don't clobber longer matches
  const sorted = [...replacements].sort((a, b) => b.original.length - a.original.length);

  for (const page of pdfDoc.getPages()) {
    const contentsRef = page.node.get(PDFName.of('Contents'));
    if (!contentsRef) continue;

    const refs: unknown[] = [];
    const lookedUp = pdfDoc.context.lookup(contentsRef);
    if (lookedUp instanceof PDFArray) {
      for (let i = 0; i < lookedUp.size(); i++) {
        refs.push(pdfDoc.context.lookup(lookedUp.get(i)));
      }
    } else {
      refs.push(lookedUp);
    }

    for (const streamObj of refs) {
      if (!(streamObj instanceof PDFRawStream)) continue;
      try {
        const filter = streamObj.dict.get(PDFName.of('Filter'));
        const isFlate =
          filter instanceof PDFName && filter.asString() === '/FlateDecode';
        const rawBytes = isFlate
          ? zlib.inflateSync(streamObj.contents)
          : Buffer.from(streamObj.contents);

        let contentStr = rawBytes.toString('latin1');
        let modified = false;

        for (const { original } of sorted) {
          if (original.length < 3) continue;
          const escaped = escapePdfLiteralRegex(original);
          const re = new RegExp(escaped, 'g');
          if (re.test(contentStr)) {
            // Replace original characters inside PDF literal operators with spaces
            const blank = ' '.repeat(original.length);
            contentStr = contentStr.replace(re, blank);
            modified = true;
          }

          // Also match hex-encoded WinAnsi/ASCII strings (<4A6F686E...>) used by pdf-lib & many generators
          const hexTarget = Buffer.from(original, 'latin1').toString('hex').toUpperCase();
          const hexRe = new RegExp(hexTarget, 'gi');
          if (hexRe.test(contentStr)) {
            const hexBlank = '20'.repeat(original.length);
            contentStr = contentStr.replace(hexRe, hexBlank);
            modified = true;
          }
        }

        if (modified) {
          const updatedBuf = Buffer.from(contentStr, 'latin1');
          const finalBytes = isFlate ? zlib.deflateSync(updatedBuf) : updatedBuf;
          // Mutate raw stream contents and Length entry
          (streamObj as unknown as { contents: Uint8Array }).contents = new Uint8Array(finalBytes);
          streamObj.dict.set(
            PDFName.of('Length'),
            pdfDoc.context.obj(finalBytes.length)
          );
        }
      } catch {
        // Skip streams with unsupported filters safely
      }
    }
  }
}

export async function anonymizePdfBuffer(
  inputBuffer: Uint8Array,
  filename: string,
  relativePath: string,
  config: BatchConfig
): Promise<{ outputBuffer: Uint8Array; report: ProcessedFileResult }> {
  const t0 = performance.now();
  const entityCounts: Record<string, number> = {};
  const occurrences: PiiOccurrence[] = [];

  try {
    const extractedPages = await extractPdfPages(inputBuffer);
    const pdfDoc = await PDFDocument.load(inputBuffer, { ignoreEncryption: true });
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const courier = await pdfDoc.embedFont(StandardFonts.Courier);
    const pdfPages = pdfDoc.getPages();

    const originalTexts: string[] = [];
    const streamScrubList: Array<{ original: string; replacement: string }> = [];
    let nonce = 0;
    let skippedBelowThreshold = 0;
    const minConfidence =
      typeof config.minConfidence === 'number' ? config.minConfidence : 0.85;

    for (let idx = 0; idx < extractedPages.length; idx++) {
      const pageData = extractedPages[idx];
      const pdfPage = pdfPages[idx];
      if (!pdfPage) continue;

      originalTexts.push(`--- Page ${pageData.pageNumber} ---\n${pageData.text}`);
      const rawSpans: DetectedSpan[] = detectPiiInText(
        pageData.text,
        config.entities,
        config.customRules
      );
      const { accepted: spans, skippedCount } = filterByConfidence(
        rawSpans,
        minConfidence
      );
      skippedBelowThreshold += skippedCount;

      for (const span of spans) {
        nonce++;
        const replacement = generateMockReplacement(
          span,
          config.mode,
          config.consistentMapping,
          config.seed,
          nonce
        );

        entityCounts[span.entityType] = (entityCounts[span.entityType] ?? 0) + 1;
        streamScrubList.push({ original: span.text, replacement });

        const bbox = computeSpanBoundingBox(pageData, span.start, span.end);
        if (!bbox) continue;

        occurrences.push({
          id: `${idx + 1}-${nonce}`,
          page: pageData.pageNumber,
          entityType: span.entityType,
          ruleLabel: span.ruleLabel,
          original: span.text,
          replacement,
          confidence: span.confidence,
          bbox: {
            x: Math.round(bbox.x * 10) / 10,
            y: Math.round(bbox.y * 10) / 10,
            width: Math.round(bbox.width * 10) / 10,
            height: Math.round(bbox.height * 10) / 10,
          },
        });

        const drawFont = config.mode === 'solid_mask' ? courier : helvetica;
        const baseFontSize = Math.max(7, Math.min(bbox.fontSize, 14));
        let drawSize = baseFontSize;
        const textWidth = drawFont.widthOfTextAtSize(replacement, drawSize);
        const targetBoxWidth = Math.max(bbox.width + 4, Math.min(textWidth + 8, pdfPage.getWidth() - bbox.x - 18));

        // Scale down slightly if replacement text is wider than available horizontal room
        while (drawSize > 6.2 && drawFont.widthOfTextAtSize(replacement, drawSize) > targetBoxWidth - 4) {
          drawSize -= 0.4;
        }

        const boxX = Math.max(8, bbox.x - 1.5);
        const boxY = Math.max(8, bbox.y - 1);
        const boxH = Math.max(bbox.height + 2, drawSize + 4);

        if (config.mode === 'solid_mask') {
          pdfPage.drawRectangle({
            x: boxX,
            y: boxY,
            width: targetBoxWidth,
            height: boxH,
            color: rgb(0.06, 0.09, 0.16),
          });
          pdfPage.drawText(replacement, {
            x: boxX + 3,
            y: boxY + Math.max(2.5, (boxH - drawSize) * 0.35),
            size: Math.min(drawSize, 9.5),
            font: courier,
            color: rgb(0.97, 0.98, 0.99),
          });
        } else if (config.mode === 'mask_and_replace') {
          // Crisp light-slate masked field with hairline border + mock PII replacement
          pdfPage.drawRectangle({
            x: boxX,
            y: boxY,
            width: targetBoxWidth,
            height: boxH,
            color: rgb(0.94, 0.96, 0.99),
            borderColor: rgb(0.68, 0.76, 0.88),
            borderWidth: 0.6,
          });
          pdfPage.drawText(replacement, {
            x: boxX + 3,
            y: boxY + Math.max(2.5, (boxH - drawSize) * 0.35),
            size: drawSize,
            font: helvetica,
            color: rgb(0.06, 0.09, 0.16),
          });
        } else {
          // whiteout_replace: clean whiteout mask + seamless mock replacement
          pdfPage.drawRectangle({
            x: boxX,
            y: boxY,
            width: targetBoxWidth,
            height: boxH,
            color: rgb(1, 1, 1),
          });
          pdfPage.drawText(replacement, {
            x: boxX + 1,
            y: boxY + Math.max(2.5, (boxH - drawSize) * 0.35),
            size: drawSize,
            font: helvetica,
            color: rgb(0.06, 0.09, 0.16),
          });
        }
      }
    }

    if (config.scrubStream) {
      scrubStreamStrings(pdfDoc, streamScrubList);
    }

    const outputBytes = await pdfDoc.save();

    // Verify anonymized output text via pdfjs re-extraction
    const postPages = await extractPdfPages(outputBytes);
    const anonymizedTextPreview = postPages
      .map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`)
      .join('\n\n')
      .slice(0, 6000);

    const fullPostText = postPages.map((p) => p.text).join('\n');
    const leaked = occurrences.some(
      (occ) => occ.original.length >= 4 && fullPostText.includes(occ.original)
    );

    const elapsedMs = Math.round(performance.now() - t0);
    return {
      outputBuffer: outputBytes,
      report: {
        filename,
        relativePath,
        sizeBytes: inputBuffer.length,
        outputSizeBytes: outputBytes.length,
        pages: extractedPages.length,
        entitiesFound: occurrences.length,
        entitiesMasked: occurrences.length,
        skippedBelowThreshold,
        entityCounts,
        elapsedMs,
        status: 'completed',
        streamVerifiedClean: !leaked,
        occurrences,
        originalTextPreview: originalTexts.join('\n\n').slice(0, 6000),
        anonymizedTextPreview,
      },
    };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - t0);
    return {
      outputBuffer: inputBuffer,
      report: {
        filename,
        relativePath,
        sizeBytes: inputBuffer.length,
        outputSizeBytes: inputBuffer.length,
        pages: 0,
        entitiesFound: 0,
        entitiesMasked: 0,
        skippedBelowThreshold: 0,
        entityCounts,
        elapsedMs,
        status: 'error',
        error: err instanceof Error ? err.message : 'Failed to process PDF',
        streamVerifiedClean: false,
        occurrences: [],
        originalTextPreview: '',
        anonymizedTextPreview: '',
      },
    };
  }
}

interface SampleDocTemplate {
  filename: string;
  folder: string;
  title: string;
  subtitle: string;
  sections: Array<{
    heading: string;
    lines: string[];
  }>;
}

const SAMPLE_TEMPLATES: SampleDocTemplate[] = [
  {
    filename: 'rbc_chequing_statement_mar2026.pdf',
    folder: 'statements',
    title: 'ROYAL BANK PERSONAL CHEQUING STATEMENT',
    subtitle: 'Statement Period: March 1 – March 31, 2026 · CAD Account Summary',
    sections: [
      {
        heading: 'Account Holder & Branch Coordinates',
        lines: [
          'Account Holder: Margaret E. Vance',
          'Address: 145 King Street West, Suite 1200, Toronto, ON M5H 1J8',
          'Email: margaret.vance@northstarbank.ca',
          'Phone: (416) 892-3410',
          'Transit / Institution / Account: 00412-003-8901234',
        ],
      },
      {
        heading: 'Linked Products & Verification',
        lines: [
          'Chequing Account #: 4821-9034-12',
          'Visa Cardholder: Margaret E. Vance',
          'Payment Card: 4532-0151-2839-4412',
          'SIN: 482-910-338',
          'Branch Advisor: Dr. Samuel Harrison',
        ],
      },
    ],
  },
  {
    filename: 'td_lira_locked_in_transfer_form.pdf',
    folder: 'lira',
    title: 'LOCKED-IN RETIREMENT ACCOUNT (LIRA) TRANSFER AUTHORIZATION',
    subtitle: 'Ontario Pension Benefits Act (PBA) · Spousal Consent & Beneficiary Record',
    sections: [
      {
        heading: 'Plan Annuitant Information',
        lines: [
          'Applicant: David K. Thorne',
          'SIN: 519-402-770',
          'DOB: 1988-11-03',
          'Address: 220 4th Avenue SW, Suite 800, Calgary, AB T2P 0H7',
          'Phone: (403) 641-9982',
          'Email: david.thorne@albertawealth.ca',
        ],
      },
      {
        heading: 'LIRA Account & Beneficiary Designation',
        lines: [
          'LIRA Account #: LIRA-77392018',
          'RRSP Account #: RRSP-33104821',
          'Beneficiary: Claire Montgomery',
          'Spouse: Claire Montgomery',
          'Transit / Inst / Acct: 12094-004-4829104',
        ],
      },
    ],
  },
  {
    filename: 'maple_tech_biweekly_payslip_14.pdf',
    folder: 'payslips',
    title: 'CANADIAN BI-WEEKLY EARNINGS & DEDUCTIONS STATEMENT',
    subtitle: 'Pay Period #14 · CPP, EI & Federal/Provincial Tax Withholding',
    sections: [
      {
        heading: 'Employee & Tax Profile',
        lines: [
          'Employee Name: Elena M. Rostova',
          'SIN: 623-814-258',
          'DOB: 1984-08-25',
          'Address: 880 Hornby Street, Vancouver, BC V6Z 2E6',
          'Phone: (604) 774-1920',
          'Email: elena.rostova@pacifictech.ca',
        ],
      },
      {
        heading: 'Direct Deposit & CRA Payroll Reference',
        lines: [
          'CRA Payroll Business No.: 849201442 RP 0001',
          'Direct Deposit: 00090-010-7748291',
          'TFSA Contribution Acct: TFSA-99102834',
          'Employer Contact: Thomas B. Whitfield',
        ],
      },
    ],
  },
  {
    filename: 'ontario_family_court_divorce_decree.pdf',
    folder: 'legal',
    title: 'SUPERIOR COURT OF JUSTICE (ONTARIO) — DIVORCE ORDER',
    subtitle: 'Family Law Rules · Matrimonial Asset & Spousal Support Disposition',
    sections: [
      {
        heading: 'Court Proceeding & Parties',
        lines: [
          'Court File No.: FS-24-0091842-0000',
          'Petitioner: Robert J. Callahan',
          'Respondent: Margaret E. Vance',
          'Date of Marriage: 2012-06-16',
          'Separation Date: 2023-09-01',
          'Address: 340 Laurier Avenue West, Ottawa, ON K1R 7X6',
        ],
      },
      {
        heading: 'Support Payment & Division of Pension (LIRA)',
        lines: [
          'Payor: Robert J. Callahan',
          'Payee: Margaret E. Vance',
          'Support Direct Deposit: 03120-002-5591024',
          'LIRA Division Account: LIRA-88412093',
          'SIN: 714-352-911',
        ],
      },
    ],
  },
  {
    filename: 'cra_notice_of_assessment_2025.pdf',
    folder: 'tax',
    title: 'CANADA REVENUE AGENCY — NOTICE OF ASSESSMENT (2025)',
    subtitle: 'T1 Individual Income Tax Return · RRSP & TFSA Deduction Limit',
    sections: [
      {
        heading: 'Taxpayer Identification',
        lines: [
          'Taxpayer: Jonathan P. Mercer',
          'SIN: 482-910-338',
          'DOB: 1992-02-14',
          'Address: 1250 Boulevard René-Lévesque Ouest, Montreal, QC H3B 4W8',
          'Phone: (514) 338-4501',
          'Email: j.mercer@laurentian.ca',
        ],
      },
      {
        heading: 'Assessment Reference & Registered Accounts',
        lines: [
          'CRA Ref No.: CRA-2025-8841209',
          'Ontario DL: M4920-41829-20214',
          'RRSP Account #: RRSP-66201944',
          'Passport: GA884120',
          'Prepared for: Jonathan P. Mercer',
        ],
      },
    ],
  },
];

export async function generateSamplePdfBatch(count = 5): Promise<
  Array<{ filename: string; relativePath: string; bytes: Uint8Array }>
> {
  const results: Array<{ filename: string; relativePath: string; bytes: Uint8Array }> = [];
  const total = Math.max(1, Math.min(count, 50));

  for (let i = 0; i < total; i++) {
    const tpl = SAMPLE_TEMPLATES[i % SAMPLE_TEMPLATES.length];
    const suffix = i >= SAMPLE_TEMPLATES.length ? `_copy_${i + 1}` : '';
    const filename = tpl.filename.replace('.pdf', `${suffix}.pdf`);
    const relativePath = `${tpl.folder}/${filename}`;

    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
    const fontRegular = await doc.embedFont(StandardFonts.Helvetica);

    // Header banner
    page.drawRectangle({
      x: 48,
      y: 696,
      width: 516,
      height: 54,
      color: rgb(0.95, 0.96, 0.98),
      borderColor: rgb(0.84, 0.87, 0.92),
      borderWidth: 0.75,
    });
    page.drawText(tpl.title, {
      x: 62,
      y: 726,
      size: 13,
      font: fontBold,
      color: rgb(0.06, 0.09, 0.16),
    });
    page.drawText(tpl.subtitle, {
      x: 62,
      y: 709,
      size: 9.5,
      font: fontRegular,
      color: rgb(0.35, 0.42, 0.52),
    });

    let cursorY = 656;
    for (const section of tpl.sections) {
      page.drawText(section.heading, {
        x: 48,
        y: cursorY,
        size: 11,
        font: fontBold,
        color: rgb(0.11, 0.31, 0.85),
      });
      cursorY -= 8;
      page.drawLine({
        start: { x: 48, y: cursorY },
        end: { x: 564, y: cursorY },
        thickness: 0.6,
        color: rgb(0.85, 0.88, 0.92),
      });
      cursorY -= 20;

      for (const line of section.lines) {
        page.drawText(line, {
          x: 56,
          y: cursorY,
          size: 10.5,
          font: fontRegular,
          color: rgb(0.09, 0.12, 0.18),
        });
        cursorY -= 22;
      }
      cursorY -= 16;
    }

    page.drawText(
      'Notice: This synthetic sample document contains fabricated test PII for batch redaction verification.',
      {
        x: 48,
        y: 52,
        size: 8.5,
        font: fontRegular,
        color: rgb(0.45, 0.5, 0.58),
      }
    );

    const bytes = await doc.save();
    results.push({ filename, relativePath, bytes });
  }

  return results;
}
