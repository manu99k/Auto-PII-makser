import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
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
  extractCibcContext,
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
          } else if (
            prevEndX !== null &&
            x - prevEndX > fontSize * 0.22 &&
            !fullText.endsWith(' ') &&
            !str.startsWith(' ')
          ) {
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

      // Include any unflattened AcroForm Widget annotation text values (only present if flattening failed)
      try {
        const annots = await page.getAnnotations();
        for (const annot of annots) {
          if (
            annot &&
            annot.subtype === 'Widget' &&
            typeof annot.fieldValue === 'string' &&
            annot.fieldValue.trim().length > 0 &&
            Array.isArray(annot.rect) &&
            annot.rect.length === 4
          ) {
            const val = annot.fieldValue.trim();
            const [rx1, ry1, rx2, ry2] = annot.rect as number[];
            const boxW = Math.max(12, Math.abs(rx2 - rx1));
            const boxH = Math.max(10, Math.abs(ry2 - ry1));
            const fontSize = Math.max(7, Math.min(12, boxH * 0.65));
            const x = Math.min(rx1, rx2) + 2;
            const y = Math.min(ry1, ry2) + Math.max(2, (boxH - fontSize) * 0.35);

            if (fullText.length > 0) fullText += '\n';
            const startOffset = fullText.length;
            fullText += val;
            const endOffset = fullText.length;

            mappedItems.push({
              box: { str: val, x, y, width: boxW, height: boxH, fontSize },
              startOffset,
              endOffset,
            });
          }
        }
      } catch {
        // Ignore annotation extraction errors on exotic PDFs
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

    minX = Math.min(minX, subX0 - 1.5);
    maxX = Math.max(maxX, subX1 + 2.0);
    minY = Math.min(minY, box.y - box.fontSize * 0.35);
    maxY = Math.max(maxY, box.y + box.fontSize * 1.08);
    avgFont += box.fontSize;
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(14, maxX - minX),
    height: Math.max(11, maxY - minY),
    fontSize: avgFont / overlapping.length,
  };
}

function escapePdfLiteralRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scrubTjKerningArrays(
  contentStr: string,
  targets: string[]
): { content: string; modified: boolean } {
  let modified = false;
  const tjBlockRe = /\[([^\]]{1,8000})\]\s*TJ/g;

  const updated = contentStr.replace(tjBlockRe, (fullMatch, inner: string) => {
    const segRe = /\(((?:\\.|[^\\()])*)\)/g;
    const segments: Array<{
      rawStart: number;
      rawEnd: number;
      decoded: string;
      joinedStart: number;
      joinedEnd: number;
    }> = [];

    let joined = '';
    let sm: RegExpExecArray | null;
    while ((sm = segRe.exec(inner)) !== null) {
      const decoded = sm[1]
        .replace(/\\([()\\])/g, '$1')
        .replace(/\\r/g, '\r')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t');
      const joinedStart = joined.length;
      joined += decoded;
      const joinedEnd = joined.length;
      segments.push({
        rawStart: sm.index + 1,
        rawEnd: sm.index + 1 + sm[1].length,
        decoded,
        joinedStart,
        joinedEnd,
      });
    }

    if (segments.length === 0 || joined.length < 3) return fullMatch;

    const blankMask = new Array<boolean>(joined.length).fill(false);
    let blockHit = false;

    for (const orig of targets) {
      if (orig.length < 3) continue;
      let searchFrom = 0;
      const lowerJoined = joined.toLowerCase();
      const lowerOrig = orig.toLowerCase();
      while (searchFrom < lowerJoined.length) {
        const idx = lowerJoined.indexOf(lowerOrig, searchFrom);
        if (idx === -1) break;
        for (let k = idx; k < idx + orig.length; k++) {
          blankMask[k] = true;
        }
        blockHit = true;
        searchFrom = idx + orig.length;
      }
    }

    if (!blockHit) return fullMatch;

    modified = true;
    let rebuilt = '';
    let innerCursor = 0;
    for (const seg of segments) {
      rebuilt += inner.slice(innerCursor, seg.rawStart);
      let segOut = '';
      for (let i = 0; i < seg.decoded.length; i++) {
        const ch = blankMask[seg.joinedStart + i] ? ' ' : seg.decoded[i];
        if (ch === '(' || ch === ')' || ch === '\\') {
          segOut += `\\${ch}`;
        } else {
          segOut += ch;
        }
      }
      rebuilt += segOut;
      innerCursor = seg.rawEnd;
    }
    rebuilt += inner.slice(innerCursor);
    return `[${rebuilt}] TJ`;
  });

  return { content: updated, modified };
}

function scrubStreamStrings(
  pdfDoc: PDFDocument,
  replacements: Array<{ original: string; replacement: string }>
) {
  if (replacements.length === 0) return;
  // Sort longest first so partial substrings don't clobber longer matches
  const sorted = [...replacements].sort((a, b) => b.original.length - a.original.length);
  const uniqueOriginals = Array.from(new Set(sorted.map((r) => r.original))).filter(
    (s) => s.length >= 3
  );
  if (uniqueOriginals.length === 0) return;

  for (const [, obj] of pdfDoc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    try {
      const subtype = obj.dict.get(PDFName.of('Subtype'));
      const subtypeStr = subtype instanceof PDFName ? subtype.asString() : '';
      if (
        subtypeStr === '/Image' ||
        subtypeStr === '/Type1C' ||
        subtypeStr === '/CIDFontType0C' ||
        subtypeStr === '/OpenType'
      ) {
        continue;
      }
      const typeName = obj.dict.get(PDFName.of('Type'));
      const typeStr = typeName instanceof PDFName ? typeName.asString() : '';
      if (typeStr === '/XRef' || typeStr === '/ObjStm') continue;
      if (obj.dict.has(PDFName.of('Length1'))) continue;

      const filter = obj.dict.get(PDFName.of('Filter'));
      let isFlate = false;
      if (!filter) {
        isFlate = false;
      } else if (filter instanceof PDFName && filter.asString() === '/FlateDecode') {
        isFlate = true;
      } else if (
        filter instanceof PDFArray &&
        filter.size() === 1 &&
        filter.get(0) instanceof PDFName &&
        (filter.get(0) as PDFName).asString() === '/FlateDecode'
      ) {
        isFlate = true;
      } else {
        continue; // Skip DCTDecode/JPXDecode/unsupported binary filters
      }

      const rawBytes = isFlate ? zlib.inflateSync(obj.contents) : Buffer.from(obj.contents);
      let contentStr = rawBytes.toString('latin1');
      let modified = false;

      for (const original of uniqueOriginals) {
        // 1. Direct PDF literal string match (ASCII / escaped parens)
        const escaped = escapePdfLiteralRegex(original);
        const re = new RegExp(escaped, 'g');
        if (re.test(contentStr)) {
          contentStr = contentStr.replace(re, ' '.repeat(original.length));
          modified = true;
        }

        // Also match PDF-escaped parens inside literal strings e.g. \(416\) 892-3410
        const pdfEscaped = original
          .replace(/\\/g, '\\\\')
          .replace(/\(/g, '\\(')
          .replace(/\)/g, '\\)');
        if (pdfEscaped !== original) {
          const pdfEscRe = new RegExp(escapePdfLiteralRegex(pdfEscaped), 'g');
          if (pdfEscRe.test(contentStr)) {
            contentStr = contentStr.replace(pdfEscRe, ' '.repeat(original.length));
            modified = true;
          }
        }

        // 2. Hex-encoded WinAnsi/ASCII strings (<4A6F686E...>) used by pdf-lib & PDF writers
        const hexTarget = Buffer.from(original, 'latin1').toString('hex').toUpperCase();
        const hexRe = new RegExp(hexTarget, 'gi');
        if (hexRe.test(contentStr)) {
          contentStr = contentStr.replace(hexRe, '20'.repeat(original.length));
          modified = true;
        }
      }

      // 3. Split-kerning TJ array strings: [(da) -12 (vid@ex) 8 (ample.ca)] TJ
      const tjResult = scrubTjKerningArrays(contentStr, uniqueOriginals);
      if (tjResult.modified) {
        contentStr = tjResult.content;
        modified = true;
      }

      if (modified) {
        const updatedBuf = Buffer.from(contentStr, 'latin1');
        const finalBytes = isFlate ? zlib.deflateSync(updatedBuf) : updatedBuf;
        (obj as unknown as { contents: Uint8Array }).contents = new Uint8Array(finalBytes);
        obj.dict.set(PDFName.of('Length'), pdfDoc.context.obj(finalBytes.length));
      }
    } catch {
      // Skip streams that fail inflation cleanly
    }
  }
}

function decodePdfStringValue(val: unknown): string {
  if (val instanceof PDFString) return val.decodeText();
  if (val instanceof PDFHexString) return val.decodeText();
  return '';
}

function rectsOverlap(
  a: [number, number, number, number],
  b: { x: number; y: number; width: number; height: number },
  pad = 4
): boolean {
  const ax1 = Math.min(a[0], a[2]);
  const ay1 = Math.min(a[1], a[3]);
  const ax2 = Math.max(a[0], a[2]);
  const ay2 = Math.max(a[1], a[3]);

  const bx1 = b.x - pad;
  const by1 = b.y - pad;
  const bx2 = b.x + b.width + pad;
  const by2 = b.y + b.height + pad;

  return ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1;
}

function readRectTuple(pdfDoc: PDFDocument, dict: PDFDict): [number, number, number, number] | null {
  const rawRect = dict.get(PDFName.of('Rect'));
  const rectArr = pdfDoc.context.lookup(rawRect);
  if (!(rectArr instanceof PDFArray) || rectArr.size() < 4) return null;
  const nums: number[] = [];
  for (let i = 0; i < 4; i++) {
    const item = pdfDoc.context.lookup(rectArr.get(i));
    if (!(item instanceof PDFNumber)) return null;
    nums.push(item.asNumber());
  }
  return [nums[0], nums[1], nums[2], nums[3]];
}

function scrubAnnotationsAndLinks(
  pdfDoc: PDFDocument,
  extractedPages: ExtractedPage[],
  pagePlans: Map<number, PageRedactionPlan[]>,
  allRedactedStrings: string[]
) {
  const lowerTargets = allRedactedStrings
    .filter((s) => s.length >= 3)
    .map((s) => s.toLowerCase());

  const pdfPages = pdfDoc.getPages();
  for (let idx = 0; idx < pdfPages.length; idx++) {
    const pdfPage = pdfPages[idx];
    const pageNum = extractedPages[idx]?.pageNumber ?? idx + 1;
    const plans = pagePlans.get(pageNum) ?? [];

    const annotsRef = pdfPage.node.get(PDFName.of('Annots'));
    if (!annotsRef) continue;
    const annotsObj = pdfDoc.context.lookup(annotsRef);
    if (!(annotsObj instanceof PDFArray)) continue;

    for (let i = annotsObj.size() - 1; i >= 0; i--) {
      try {
        const annot = pdfDoc.context.lookup(annotsObj.get(i));
        if (!(annot instanceof PDFDict)) continue;

        const subtype = annot.get(PDFName.of('Subtype'));
        const subtypeStr = subtype instanceof PDFName ? subtype.asString() : '';
        const rect = readRectTuple(pdfDoc, annot);
        const overlapsRedaction =
          rect !== null && plans.some((p) => rectsOverlap(rect, p.bbox, 6));

        let matchesUriOrText = false;
        if (subtypeStr === '/Link') {
          const action = pdfDoc.context.lookup(annot.get(PDFName.of('A')));
          if (action instanceof PDFDict) {
            const uri = decodePdfStringValue(pdfDoc.context.lookup(action.get(PDFName.of('URI'))));
            const lowerUri = uri.toLowerCase();
            if (lowerUri && lowerTargets.some((t) => lowerUri.includes(t))) {
              matchesUriOrText = true;
            }
          }
          const contents = decodePdfStringValue(pdfDoc.context.lookup(annot.get(PDFName.of('Contents'))));
          if (contents && lowerTargets.some((t) => contents.toLowerCase().includes(t))) {
            matchesUriOrText = true;
          }
          if (overlapsRedaction || matchesUriOrText) {
            annotsObj.remove(i);
          }
        } else if (subtypeStr === '/Widget') {
          const val = decodePdfStringValue(pdfDoc.context.lookup(annot.get(PDFName.of('V'))));
          const dv = decodePdfStringValue(pdfDoc.context.lookup(annot.get(PDFName.of('DV'))));
          const combined = `${val}\n${dv}`.toLowerCase();
          if (
            overlapsRedaction ||
            (combined.trim() && lowerTargets.some((t) => combined.includes(t)))
          ) {
            annotsObj.remove(i);
          }
        } else if (overlapsRedaction) {
          // Remove any popup/text/markup annotation sitting over a redacted area
          annotsObj.remove(i);
        }
      } catch {
        // Continue inspecting remaining annotations safely
      }
    }
  }
}

function scrubPdfMetadata(pdfDoc: PDFDocument, allRedactedStrings: string[]) {
  const targets = allRedactedStrings.filter((s) => s.length >= 4);
  if (targets.length === 0) return;

  const scrubVal = (val: string | undefined): string | undefined => {
    if (!val) return val;
    let out = val;
    for (const t of targets) {
      const re = new RegExp(escapePdfLiteralRegex(t), 'gi');
      if (re.test(out)) {
        out = out.replace(re, '[REDACTED]');
      }
    }
    return out;
  };

  try {
    const title = scrubVal(pdfDoc.getTitle());
    if (title !== undefined) pdfDoc.setTitle(title);
    const author = scrubVal(pdfDoc.getAuthor());
    if (author !== undefined) pdfDoc.setAuthor(author);
    const subject = scrubVal(pdfDoc.getSubject());
    if (subject !== undefined) pdfDoc.setSubject(subject);
  } catch {
    // Ignore metadata read/write errors on malformed Info dicts
  }
}

function toWinAnsiSafe(text: string): string {
  const normalized = text
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201A\u2039\u203A]/g, "'")
    .replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"')
    .replace(/\u2022/g, '*')
    .replace(/\u2026/g, '...');

  let out = '';
  for (const ch of normalized) {
    const code = ch.charCodeAt(0);
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      out += ch;
    } else {
      const ascii = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
      for (const sub of ascii) {
        const sc = sub.charCodeAt(0);
        if ((sc >= 0x20 && sc <= 0x7e) || (sc >= 0xa0 && sc <= 0xff)) {
          out += sub;
        } else {
          out += ' ';
        }
      }
    }
  }
  return out;
}

interface PageRedactionPlan {
  spanStart: number;
  spanEnd: number;
  replacement: string;
  bbox: { x: number; y: number; width: number; height: number; fontSize: number };
}

function drawRedactionOverlay(
  pdfPage: ReturnType<PDFDocument['getPages']>[number],
  bbox: PageRedactionPlan['bbox'],
  replacement: string,
  mode: BatchConfig['mode'],
  helvetica: Awaited<ReturnType<PDFDocument['embedFont']>>,
  courier: Awaited<ReturnType<PDFDocument['embedFont']>>
) {
  const safeReplacement = toWinAnsiSafe(replacement) || '[MASKED]';
  const drawFont = mode === 'solid_mask' ? courier : helvetica;
  const baseFontSize = Math.max(7, Math.min(bbox.fontSize, 14));
  let drawSize = baseFontSize;
  const textWidth = drawFont.widthOfTextAtSize(safeReplacement, drawSize);
  const pageWidth = pdfPage.getWidth();
  const maxAvailWidth = Math.max(40, pageWidth - bbox.x - 14);
  const targetBoxWidth = Math.max(bbox.width + 6, Math.min(textWidth + 8, maxAvailWidth));

  // Scale down slightly if replacement text is wider than available horizontal room
  while (drawSize > 6.2 && drawFont.widthOfTextAtSize(safeReplacement, drawSize) > targetBoxWidth - 4) {
    drawSize -= 0.4;
  }

  const boxX = Math.max(4, bbox.x - 1.5);
  const boxY = Math.max(4, bbox.y - 1.5);
  const boxH = Math.max(bbox.height + 3, drawSize + 5);

  if (mode === 'solid_mask') {
    pdfPage.drawRectangle({
      x: boxX,
      y: boxY,
      width: targetBoxWidth,
      height: boxH,
      color: rgb(0.06, 0.09, 0.16),
    });
    pdfPage.drawText(safeReplacement, {
      x: boxX + 3,
      y: boxY + Math.max(2.5, (boxH - drawSize) * 0.35),
      size: Math.min(drawSize, 9.5),
      font: courier,
      color: rgb(0.97, 0.98, 0.99),
    });
  } else if (mode === 'mask_and_replace') {
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
    pdfPage.drawText(safeReplacement, {
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
    pdfPage.drawText(safeReplacement, {
      x: boxX + 1.5,
      y: boxY + Math.max(2.5, (boxH - drawSize) * 0.35),
      size: drawSize,
      font: helvetica,
      color: rgb(0.06, 0.09, 0.16),
    });
  }
}

async function buildReconstructedAnonymizedPdf(
  extractedPages: ExtractedPage[],
  pagePlans: Map<number, PageRedactionPlan[]>,
  mode: BatchConfig['mode']
): Promise<Uint8Array> {
  const cleanDoc = await PDFDocument.create();
  const helvetica = await cleanDoc.embedFont(StandardFonts.Helvetica);
  const courier = await cleanDoc.embedFont(StandardFonts.Courier);

  for (const pageData of extractedPages) {
    const width = Math.max(200, pageData.width || 612);
    const height = Math.max(200, pageData.height || 792);
    const page = cleanDoc.addPage([width, height]);
    const plans = pagePlans.get(pageData.pageNumber) ?? [];

    page.drawRectangle({
      x: 0,
      y: 0,
      width,
      height,
      color: rgb(1, 1, 1),
    });

    for (const item of pageData.items) {
      const overlapping = plans.filter(
        (p) => item.endOffset > p.spanStart && item.startOffset < p.spanEnd
      );

      let drawStr = item.box.str;
      if (overlapping.length > 0) {
        const chars = drawStr.split('');
        for (const p of overlapping) {
          const localStart = Math.max(0, p.spanStart - item.startOffset);
          const localEnd = Math.min(chars.length, p.spanEnd - item.startOffset);
          for (let i = localStart; i < localEnd; i++) {
            chars[i] = ' ';
          }
        }
        drawStr = chars.join('');
      }

      const safeText = toWinAnsiSafe(drawStr);
      if (safeText.trim().length > 0) {
        page.drawText(safeText, {
          x: item.box.x,
          y: item.box.y,
          size: Math.max(5.5, Math.min(item.box.fontSize, 28)),
          font: helvetica,
          color: rgb(0.09, 0.12, 0.18),
        });
      }
    }

    for (const plan of plans) {
      drawRedactionOverlay(page, plan.bbox, plan.replacement, mode, helvetica, courier);
    }
  }

  return cleanDoc.save();
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
    // Flatten interactive AcroForm fields FIRST so pdfjs-dist extracts all filled form values
    // and redactions draw on top of flattened text instead of underneath Widget annotations
    let workingBuffer = inputBuffer;
    let preLoadedDoc: PDFDocument | null = null;
    try {
      const candidateDoc = await PDFDocument.load(inputBuffer, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
      const form = candidateDoc.getForm();
      if (form.getFields().length > 0) {
        form.flatten();
        workingBuffer = await candidateDoc.save();
        preLoadedDoc = await PDFDocument.load(workingBuffer, {
          ignoreEncryption: true,
          updateMetadata: false,
        });
      } else {
        preLoadedDoc = candidateDoc;
      }
    } catch {
      preLoadedDoc = null;
      workingBuffer = inputBuffer;
    }

    const extractedPages = await extractPdfPages(workingBuffer);
    const originalTexts: string[] = [];
    const streamScrubList: Array<{ original: string; replacement: string }> = [];
    const pagePlans = new Map<number, PageRedactionPlan[]>();
    let nonce = 0;
    let skippedBelowThreshold = 0;
    const minConfidence =
      typeof config.minConfidence === 'number' ? config.minConfidence : 0.85;
    const ignoreCibcEmployees = config.ignoreCibcEmployees !== false;
    const docCibcEmployeeKeys = new Set<string>();
    if (ignoreCibcEmployees) {
      for (const pageData of extractedPages) {
        const { cibcEmployeeNameKeys } = extractCibcContext(pageData.text);
        for (const k of cibcEmployeeNameKeys) docCibcEmployeeKeys.add(k);
      }
    }

    for (let idx = 0; idx < extractedPages.length; idx++) {
      const pageData = extractedPages[idx];
      originalTexts.push(`--- Page ${pageData.pageNumber} ---\n${pageData.text}`);
      const rawSpans: DetectedSpan[] = detectPiiInText(
        pageData.text,
        config.entities,
        config.customRules,
        { ignoreCibcEmployees, extraIgnoredPersonKeys: docCibcEmployeeKeys }
      );
      const { accepted: spans, skippedCount } = filterByConfidence(
        rawSpans,
        minConfidence
      );
      skippedBelowThreshold += skippedCount;

      const plansForPage: PageRedactionPlan[] = [];
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

        plansForPage.push({
          spanStart: span.start,
          spanEnd: span.end,
          replacement,
          bbox,
        });
      }
      pagePlans.set(pageData.pageNumber, plansForPage);
    }

    const allRedactedOriginals = occurrences.map((o) => o.original);
    let outputBytes: Uint8Array;
    try {
      const pdfDoc =
        preLoadedDoc ??
        (await PDFDocument.load(workingBuffer, {
          ignoreEncryption: true,
          updateMetadata: false,
        }));

      const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const courier = await pdfDoc.embedFont(StandardFonts.Courier);
      const pdfPages = pdfDoc.getPages();

      // Remove clickable mailto:/URI link annotations & widgets under redacted PII
      scrubAnnotationsAndLinks(pdfDoc, extractedPages, pagePlans, allRedactedOriginals);

      for (let idx = 0; idx < extractedPages.length; idx++) {
        const pageData = extractedPages[idx];
        const pdfPage = pdfPages[idx];
        if (!pdfPage) continue;
        const plans = pagePlans.get(pageData.pageNumber) ?? [];
        for (const plan of plans) {
          drawRedactionOverlay(pdfPage, plan.bbox, plan.replacement, config.mode, helvetica, courier);
        }
      }

      if (config.scrubStream) {
        scrubStreamStrings(pdfDoc, streamScrubList);
        scrubPdfMetadata(pdfDoc, allRedactedOriginals);
      }

      outputBytes = await pdfDoc.save();
    } catch {
      // Fallback for malformed PDFs (e.g. broken PDFDict/indirect refs) that pdfjs-dist parsed cleanly
      outputBytes = await buildReconstructedAnonymizedPdf(
        extractedPages,
        pagePlans,
        config.mode
      );
    }

    // Verify anonymized output text via pdfjs re-extraction
    let postPages = await extractPdfPages(outputBytes);
    let fullPostText = postPages.map((p) => p.text).join('\n');
    let leaked = occurrences.some(
      (occ) => occ.original.length >= 4 && fullPostText.includes(occ.original)
    );

    // If underlying CID/Identity-H/compressed objects still leaked original PII text,
    // rebuild clean stream-scrubbed pages so 0% original PII remains recoverable
    if (config.scrubStream && leaked) {
      outputBytes = await buildReconstructedAnonymizedPdf(
        extractedPages,
        pagePlans,
        config.mode
      );
      postPages = await extractPdfPages(outputBytes);
      fullPostText = postPages.map((p) => p.text).join('\n');
      leaked = occurrences.some(
        (occ) => occ.original.length >= 4 && fullPostText.includes(occ.original)
      );
    }

    const anonymizedTextPreview = postPages
      .map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`)
      .join('\n\n')
      .slice(0, 6000);

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
    filename: 'quebec_reee_transfert_iqee_tp1029.pdf',
    folder: 'french',
    title: 'FORMULAIRE TP-1029.8.R2-V — TRANSFERT REEE / IQEE (QUÉBEC)',
    subtitle: 'Incitatif québécois à l’épargne-études · Services Investisseurs CIBC',
    sections: [
      {
        heading: 'Coordonnées de la succursale (CIBC)',
        lines: [
          'Conseiller CIBC: David Goldstein',
          'Courriel: david.goldstein@cibc.com',
          'Transit: 07012',
        ],
      },
      {
        heading: 'Renseignements sur le client et le régime',
        lines: [
          'Nom du client: Jean-François Tremblay',
          'NAS: 482-910-338',
          'Date de naissance: 14 février 1986',
          'Adresse: 1250 Boulevard René-Lévesque Ouest, Montréal, QC H3B 4W8',
          'Téléphone: (514) 338-4501',
          'Courriel: jf.tremblay@laurentian.ca',
          'Numéro de régime REEE: 101134059-18',
          'Numéro de compte: 654321',
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
    page.drawText(toWinAnsiSafe(tpl.title), {
      x: 62,
      y: 726,
      size: 13,
      font: fontBold,
      color: rgb(0.06, 0.09, 0.16),
    });
    page.drawText(toWinAnsiSafe(tpl.subtitle), {
      x: 62,
      y: 709,
      size: 9.5,
      font: fontRegular,
      color: rgb(0.35, 0.42, 0.52),
    });

    let cursorY = 656;
    for (const section of tpl.sections) {
      page.drawText(toWinAnsiSafe(section.heading), {
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
        page.drawText(toWinAnsiSafe(line), {
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
