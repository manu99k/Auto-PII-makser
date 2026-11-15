import crypto from 'node:crypto';
import { fakerEN_CA as faker } from '@faker-js/faker';
import type { CustomRule, PiiEntityType, RedactionMode } from '../src/types.ts';

export interface DetectedSpan {
  entityType: PiiEntityType;
  ruleLabel?: string;
  text: string;
  start: number;
  end: number;
  confidence: number;
  mockTemplate?: string;
}

export const ALL_PII_ENTITIES: PiiEntityType[] = [
  'PERSON',
  'SIN',
  'CANADIAN_BANK_ACCOUNT',
  'ADDRESS',
  'PHONE',
  'EMAIL',
  'CREDIT_CARD',
  'DOB',
  'LEGAL_CASE_ID',
  'PASSPORT',
];

function luhnValid(raw: string, minLen = 13, maxLen = 19): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < minLen || digits.length > maxLen) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function sinLuhnValid(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 9) return false;
  if (digits[0] === '0' || digits[0] === '8') return false;
  return luhnValid(digits, 9, 9);
}

const CA_PROVINCES = '(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)';
const CA_POSTAL_STR = '[ABCEGHJKLMNPRSTVXY]\\d[ABCEGHJKLMNPRSTVWXYZ][ -]?\\d[ABCEGHJKLMNPRSTVWXYZ]\\d';
const CA_STREET_SUFFIX =
  '(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Way|Crescent|Cres|Parkway|Pkwy|Circle|Cir|Place|Pl|Trail|Tr|Terrace|Terr)';
const CA_FR_PREFIX = '(?:Rue|Avenue|Boulevard|Chemin|Allée|Impasse)';

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Canadian SIN (XXX-XXX-XXX or XXX XXX XXX)
const SIN_LABELED_RE =
  /(?:(?:SIN|Social[ \t]+Insurance[ \t]+(?:Number|No\.?)|NAS)[ \t]*[:\-#]?[ \t]*)(\d{3}[ -]?\d{3}[ -]?\d{3})\b/gi;
const SIN_DASH_RE = /\b[1-79]\d{2}-\d{3}-\d{3}\b/g;
const SIN_SPACE_RE = /\b[1-79]\d{2} \d{3} \d{3}\b/g;

const PHONE_FORMATTED_RE = /(?:(?:\+?1[-.\s]?)?(?:\(\d{3}\)[-.\s]?|\d{3}[-.\s])\d{3}[-.\s]\d{4})\b/g;
const PHONE_COMPACT_RE = /\b(?:\+?1)?\d{10}\b/g;
const CREDIT_CARD_RE = /\b(?:\d{4}[-\s]?){3}\d{4}\b|\b\d{13,19}\b/g;

// Canadian Transit-Institution-Account & LIRA/RRSP/TFSA/Mortgage accounts
const BANK_TRANSIT_TUPLE_RE = /\b\d{5}[-\s]\d{3}[-\s]\d{7,12}\b/g;
const BANK_LABELED_ACCOUNT_RE =
  /(?:(?:LIRA|RRSP|TFSA|RRIF|RESP|Account|Acct|Chequing|Savings|Mortgage|Policy|Contract|Transit|Institution|EFT)[ \t]*(?:No\.?|Number|#)?[ \t]*[:\-#][ \t]*)([A-Z]{0,5}[-]?\d{3,14}(?:[- ]\d{2,12}){0,2})\b/gi;

// Canadian Court File / Divorce Docket / CRA Business & Payroll IDs
const CRA_BN_RE = /\b\d{9}[ \t]?(?:RP|RC|RT|RR)[ \t]?\d{4}\b/g;
const LEGAL_CASE_RE =
  /(?:(?:Court[ \t]*File|Docket|Action|Divorce[ \t]*File|Case|CRA[ \t]*(?:Ref|Payroll|Business)|Notice[ \t]*Ref)[ \t]*(?:No\.?|Number|#)?[ \t]*[:\-#][ \t]*)([A-Z0-9]{2,6}(?:[- ][A-Z0-9]{2,10}){1,3})\b/gi;

const DOB_RE =
  /(?:(?:DOB|Date[ \t]+of[ \t]+Birth|Birth[ \t]*Date|Born|Date[ \t]+of[ \t]+Marriage|Separation[ \t]+Date)[ \t]*[:\-]?[ \t]*)((?:0?[1-9]|1[0-2])[/\-](?:0?[1-9]|[12]\d|3[01])[/\-](?:19|20)\d{2}|(?:19|20)\d{2}[/\-](?:0?[1-9]|1[0-2])[/\-](?:0?[1-9]|[12]\d|3[01])|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[ \t]+\d{1,2},?[ \t]+(?:19|20)\d{2})/gi;

const ADDRESS_FULL_CA_RE = new RegExp(
  `\\b\\d{1,6}[ \\t]+(?:(?:${CA_FR_PREFIX})[ \\t]+)?(?:[A-ZÀ-ÿ][a-zA-ZÀ-ÿ0-9.'-]+[ \\t]+){1,5}` +
    `(?:${CA_STREET_SUFFIX}\\.?(?:[ \\t]+(?:East|West|North|South|E|W|N|S|Ouest|Est|Nord|Sud))?)?` +
    `(?:,[ \\t]*(?:Apt|Suite|Ste|Unit|App|#)[ \\t]*[A-Za-z0-9-]+)?` +
    `,[ \\t]*[A-ZÀ-ÿ][a-zA-ZÀ-ÿ.\\- ]+,[ \\t]*${CA_PROVINCES}[ \\t]+${CA_POSTAL_STR}\\b`,
  'g'
);

const ADDRESS_STREET_RE = new RegExp(
  `\\b\\d{1,6}[ \\t]+(?:[A-ZÀ-ÿ][a-zA-ZÀ-ÿ0-9.'-]+[ \\t]+){1,4}` +
    `${CA_STREET_SUFFIX}\\.?(?:[ \\t]+(?:East|West|North|South|E|W|N|S))?` +
    `(?:,[ \\t]*(?:Apt|Suite|Ste|Unit|App|#)[ \\t]*[A-Za-z0-9-]+)?\\b`,
  'g'
);

const POSTAL_CODE_ONLY_RE = new RegExp(`\\b${CA_POSTAL_STR}\\b`, 'g');

const PASSPORT_RE =
  /(?:(?:Passport|DL|Driver'?s?[ \t]*Licen[cs]e|Ontario[ \t]*DL|ID[ \t]*No\.?)[ \t]*[:\-#]?[ \t]*)([A-Z0-9-]{6,18})\b/gi;

const PERSON_CONTEXT_RE =
  /(?:(?:Account[ \t]*Holder|Client|Customer|Employee(?:[ \t]*Name)?|Applicant|Petitioner|Respondent|Spouse|Former[ \t]*Spouse|Beneficiary|Contingent[ \t]*Beneficiary|Payor|Payee|Taxpayer|Trustee|Executor|Patient|Full[ \t]*Name|Name|Cardholder|Signed[ \t]*by|Prepared[ \t]*for|Requested[ \t]*by|Attn|Dear|Mr\.|Mrs\.|Ms\.|Dr\.)[ \t]*[:\-][ \t]*)([A-ZÀ-ÿ][a-zà-ÿ]{1,20}(?:[ \t]+[A-Z]\.?)?[ \t]+[A-ZÀ-ÿ][a-zà-ÿ'-]{1,24}(?:[ \t]+[A-ZÀ-ÿ][a-zà-ÿ'-]{1,20})?)/g;

const PERSON_STANDALONE_RE = /\b([A-Z][a-z]{2,18}(?:[ \t]+[A-Z]\.)?[ \t]+[A-Z][a-z'-]{2,22})\b/g;

const COMMON_NON_PERSON_BIGRAMS = new Set([
  'San Francisco',
  'New York',
  'North York',
  'Superior Court',
  'Family Court',
  'Notice Assessment',
  'Direct Deposit',
  'Payment Card',
  'Account Recovery',
  'Social Insurance',
  'Royal Bank',
  'Canada Revenue',
  'Revenue Agency',
  'Locked Retirement',
  'Gross Earnings',
  'Net Pay',
  'Bank Statement',
  'King Street',
  'Queen Street',
  'Yonge Street',
]);

function runRegex(
  regex: RegExp,
  text: string,
  captureGroup: number,
  callback: (matchText: string, start: number, end: number) => void
) {
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    const target = captureGroup > 0 ? m[captureGroup] : m[0];
    if (!target) continue;
    const offsetInFull = captureGroup > 0 ? m[0].indexOf(target) : 0;
    const start = m.index + Math.max(0, offsetInFull);
    const end = start + target.length;
    callback(target, start, end);
  }
}

export function detectPiiInText(
  text: string,
  enabledEntities: PiiEntityType[],
  customRules: CustomRule[] = []
): DetectedSpan[] {
  const enabled = new Set<PiiEntityType>(enabledEntities);
  const candidates: DetectedSpan[] = [];

  if (enabled.has('EMAIL')) {
    runRegex(EMAIL_RE, text, 0, (matchText, start, end) => {
      candidates.push({ entityType: 'EMAIL', text: matchText, start, end, confidence: 0.99 });
    });
  }

  if (enabled.has('SIN')) {
    runRegex(SIN_LABELED_RE, text, 1, (matchText, start, end) => {
      const conf = sinLuhnValid(matchText) ? 0.98 : 0.9;
      candidates.push({ entityType: 'SIN', text: matchText, start, end, confidence: conf });
    });
    runRegex(SIN_DASH_RE, text, 0, (matchText, start, end) => {
      if (sinLuhnValid(matchText)) {
        candidates.push({ entityType: 'SIN', text: matchText, start, end, confidence: 0.96 });
      }
    });
    runRegex(SIN_SPACE_RE, text, 0, (matchText, start, end) => {
      if (sinLuhnValid(matchText)) {
        candidates.push({ entityType: 'SIN', text: matchText, start, end, confidence: 0.88 });
      }
    });
  }

  if (enabled.has('CREDIT_CARD')) {
    runRegex(CREDIT_CARD_RE, text, 0, (matchText, start, end) => {
      if (luhnValid(matchText)) {
        candidates.push({ entityType: 'CREDIT_CARD', text: matchText, start, end, confidence: 0.98 });
      }
    });
  }

  if (enabled.has('CANADIAN_BANK_ACCOUNT')) {
    runRegex(BANK_TRANSIT_TUPLE_RE, text, 0, (matchText, start, end) => {
      candidates.push({
        entityType: 'CANADIAN_BANK_ACCOUNT',
        text: matchText,
        start,
        end,
        confidence: 0.95,
      });
    });
    runRegex(BANK_LABELED_ACCOUNT_RE, text, 1, (matchText, start, end) => {
      candidates.push({
        entityType: 'CANADIAN_BANK_ACCOUNT',
        text: matchText,
        start,
        end,
        confidence: 0.93,
      });
    });
  }

  if (enabled.has('LEGAL_CASE_ID')) {
    runRegex(CRA_BN_RE, text, 0, (matchText, start, end) => {
      candidates.push({ entityType: 'LEGAL_CASE_ID', text: matchText, start, end, confidence: 0.96 });
    });
    runRegex(LEGAL_CASE_RE, text, 1, (matchText, start, end) => {
      candidates.push({ entityType: 'LEGAL_CASE_ID', text: matchText, start, end, confidence: 0.92 });
    });
  }

  if (enabled.has('PHONE')) {
    runRegex(PHONE_FORMATTED_RE, text, 0, (matchText, start, end) => {
      const trimmed = matchText.trim();
      const digits = trimmed.replace(/\D/g, '');
      if (digits.length >= 10 && digits.length <= 15) {
        candidates.push({ entityType: 'PHONE', text: trimmed, start, end: start + trimmed.length, confidence: 0.92 });
      }
    });
    runRegex(PHONE_COMPACT_RE, text, 0, (matchText, start, end) => {
      const trimmed = matchText.trim();
      candidates.push({ entityType: 'PHONE', text: trimmed, start, end: start + trimmed.length, confidence: 0.76 });
    });
  }

  if (enabled.has('DOB')) {
    runRegex(DOB_RE, text, 1, (matchText, start, end) => {
      candidates.push({ entityType: 'DOB', text: matchText, start, end, confidence: 0.94 });
    });
  }

  if (enabled.has('ADDRESS')) {
    runRegex(ADDRESS_FULL_CA_RE, text, 0, (matchText, start, end) => {
      candidates.push({ entityType: 'ADDRESS', text: matchText, start, end, confidence: 0.94 });
    });
    runRegex(ADDRESS_STREET_RE, text, 0, (matchText, start, end) => {
      candidates.push({ entityType: 'ADDRESS', text: matchText, start, end, confidence: 0.88 });
    });
    runRegex(POSTAL_CODE_ONLY_RE, text, 0, (matchText, start, end) => {
      candidates.push({ entityType: 'ADDRESS', text: matchText, start, end, confidence: 0.91 });
    });
  }

  if (enabled.has('PASSPORT')) {
    runRegex(PASSPORT_RE, text, 1, (matchText, start, end) => {
      candidates.push({ entityType: 'PASSPORT', text: matchText, start, end, confidence: 0.9 });
    });
  }

  if (enabled.has('PERSON')) {
    runRegex(PERSON_CONTEXT_RE, text, 1, (matchText, start, end) => {
      const cleaned = matchText.trim();
      if (cleaned.length >= 5) {
        candidates.push({ entityType: 'PERSON', text: cleaned, start, end: start + cleaned.length, confidence: 0.9 });
      }
    });
    runRegex(PERSON_STANDALONE_RE, text, 1, (matchText, start, end) => {
      const cleaned = matchText.trim();
      if (cleaned.length >= 6 && !COMMON_NON_PERSON_BIGRAMS.has(cleaned)) {
        candidates.push({ entityType: 'PERSON', text: cleaned, start, end: start + cleaned.length, confidence: 0.78 });
      }
    });
  }

  for (const rule of customRules) {
    if (!rule.enabled || !rule.pattern.trim()) continue;
    try {
      const re = new RegExp(rule.pattern, 'g');
      runRegex(re, text, 0, (matchText, start, end) => {
        candidates.push({
          entityType: 'CUSTOM',
          ruleLabel: rule.label,
          text: matchText,
          start,
          end,
          confidence: 0.95,
          mockTemplate: rule.mockTemplate,
        });
      });
    } catch {
      // Ignore invalid user regex safely
    }
  }

  candidates.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const lenDiff = b.end - b.start - (a.end - a.start);
    if (lenDiff !== 0) return lenDiff;
    return b.confidence - a.confidence;
  });

  const deduped: DetectedSpan[] = [];
  let cursor = -1;
  for (const span of candidates) {
    if (span.start >= cursor) {
      deduped.push(span);
      cursor = span.end;
    }
  }
  return deduped;
}

function deterministicHashInt(input: string): number {
  const hex = crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
  return parseInt(hex, 16);
}

export function filterByConfidence(
  spans: DetectedSpan[],
  minConfidence: number
): { accepted: DetectedSpan[]; skippedCount: number } {
  const accepted: DetectedSpan[] = [];
  let skippedCount = 0;
  for (const span of spans) {
    if (span.confidence > minConfidence) {
      accepted.push(span);
    } else {
      skippedCount++;
    }
  }
  return { accepted, skippedCount };
}

function makeLuhnSin(originalText: string): string {
  const digits = [9];
  for (let i = 0; i < 7; i++) {
    digits.push(faker.number.int({ min: 0, max: 9 }));
  }
  let checksum = 0;
  for (let idx = 0; idx < digits.length; idx++) {
    let d = digits[idx];
    if (idx % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    checksum += d;
  }
  const checkDigit = (10 - (checksum % 10)) % 10;
  const full = digits.join('') + String(checkDigit);
  if (originalText.includes(' ')) {
    return `${full.slice(0, 3)} ${full.slice(3, 6)} ${full.slice(6, 9)}`;
  }
  return `${full.slice(0, 3)}-${full.slice(3, 6)}-${full.slice(6, 9)}`;
}

function makeLuhnCard(originalText: string): string {
  const digits = [4];
  for (let i = 0; i < 14; i++) {
    digits.push(faker.number.int({ min: 0, max: 9 }));
  }
  let checksum = 0;
  for (let idx = 0; idx < digits.length; idx++) {
    let d = digits[idx];
    if (idx % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    checksum += d;
  }
  const checkDigit = (10 - (checksum % 10)) % 10;
  const full = digits.join('') + String(checkDigit);
  if (originalText.includes('-')) {
    return `${full.slice(0, 4)}-${full.slice(4, 8)}-${full.slice(8, 12)}-${full.slice(12, 16)}`;
  }
  if (originalText.includes(' ')) {
    return `${full.slice(0, 4)} ${full.slice(4, 8)} ${full.slice(8, 12)} ${full.slice(12, 16)}`;
  }
  return full;
}

const CA_AREA_CODES = ['416', '647', '437', '905', '604', '778', '403', '587', '514', '438', '613', '902'];
const CA_INSTITUTIONS = ['001', '002', '003', '004', '006', '010'];

export function generateMockReplacement(
  span: DetectedSpan,
  mode: RedactionMode,
  consistent: boolean,
  seed: number,
  nonce: number
): string {
  if (mode === 'solid_mask') {
    const label = span.ruleLabel ? span.ruleLabel.toUpperCase() : span.entityType;
    return `[REDACTED:${label}]`;
  }

  const key = consistent
    ? `${seed}:${span.entityType}:${span.text.trim().toLowerCase()}`
    : `${seed}:${nonce}:${Date.now()}:${Math.random()}:${span.text}`;

  const itemSeed = deterministicHashInt(key);
  faker.seed(itemSeed);

  if (span.entityType === 'CUSTOM') {
    const tpl = span.mockTemplate?.trim();
    if (tpl) {
      return tpl
        .replace(/#/g, () => String(faker.number.int({ min: 0, max: 9 })))
        .replace(/\?/g, () => faker.string.alpha({ length: 1, casing: 'upper' }));
    }
    return `MOCK-${faker.string.alphanumeric({ length: 6, casing: 'upper' })}`;
  }

  switch (span.entityType) {
    case 'PERSON':
      return faker.person.fullName();
    case 'EMAIL': {
      const first = faker.person.firstName().toLowerCase().replace(/[^a-z]/g, '') || 'alex';
      const last = faker.person.lastName().toLowerCase().replace(/[^a-z]/g, '') || 'tremblay';
      return `${first}.${last}@example.ca`;
    }
    case 'PHONE': {
      const a = faker.helpers.arrayElement(CA_AREA_CODES);
      const b = faker.number.int({ min: 200, max: 999 });
      const c = faker.number.int({ min: 1000, max: 9999 });
      if (span.text.startsWith('+1')) return `+1-${a}-${b}-${c}`;
      if (span.text.includes('.')) return `${a}.${b}.${c}`;
      if (span.text.includes('-') && !span.text.includes('(')) return `${a}-${b}-${c}`;
      return `(${a}) ${b}-${c}`;
    }
    case 'SIN':
      return makeLuhnSin(span.text);
    case 'CREDIT_CARD':
      return makeLuhnCard(span.text);
    case 'CANADIAN_BANK_ACCOUNT': {
      if (/^\d{5}[-\s]\d{3}[-\s]\d{7,12}$/.test(span.text)) {
        const transit = String(faker.number.int({ min: 10000, max: 99999 }));
        const inst = faker.helpers.arrayElement(CA_INSTITUTIONS);
        const acct = String(faker.number.int({ min: 1000000, max: 9999999 }));
        const sep = span.text.includes(' ') ? ' ' : '-';
        return `${transit}${sep}${inst}${sep}${acct}`;
      }
      const prefix = span.text.match(/^([A-Z]{2,5}-)/)?.[1];
      const num = String(faker.number.int({ min: 10000000, max: 99999999 }));
      return prefix ? `${prefix}${num}` : `${faker.number.int({ min: 1000, max: 9999 })}-${faker.number.int({ min: 1000, max: 9999 })}-${faker.number.int({ min: 10, max: 99 })}`;
    }
    case 'LEGAL_CASE_ID': {
      if (/^\d{9}/.test(span.text)) {
        return `${faker.number.int({ min: 100000000, max: 899999999 })} RP 0001`;
      }
      const yr = faker.number.int({ min: 20, max: 26 });
      const num = String(faker.number.int({ min: 1000000, max: 9999999 }));
      return `FS-${yr}-${num}-0000`;
    }
    case 'DOB': {
      const m = String(faker.number.int({ min: 1, max: 12 })).padStart(2, '0');
      const d = String(faker.number.int({ min: 1, max: 28 })).padStart(2, '0');
      const y = faker.number.int({ min: 1955, max: 1999 });
      return `${y}-${m}-${d}`;
    }
    case 'ADDRESS': {
      const postal = faker.location.zipCode('?#? #?#').toUpperCase().replace(/[^A-Z0-9 ]/g, 'K');
      if (new RegExp(`^${CA_POSTAL_STR}$`).test(span.text.trim())) {
        return postal;
      }
      const num = faker.number.int({ min: 110, max: 8990 });
      const street = faker.location.street();
      if (!span.text.includes(',')) {
        return `${num} ${street}`;
      }
      const city = faker.location.city();
      const prov = faker.location.state({ abbreviated: true });
      return `${num} ${street}, ${city}, ${prov} ${postal}`;
    }
    case 'PASSPORT':
      return `${faker.string.alpha({ length: 2, casing: 'upper' })}${faker.number.int({ min: 100000, max: 999999 })}`;
    default:
      return '[MASKED]';
  }
}
