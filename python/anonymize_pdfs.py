#!/usr/bin/env python3
"""
Canadian Banking & Legal Batch PDF PII Anonymizer (1 to 1,000+ PDFs)
--------------------------------------------------------------------
Reads Canadian banking, wealth (LIRA/RRSP/TFSA), payroll (payslips), tax (CRA),
and family law (divorce decrees, separation agreements) PDFs from an input folder,
identifies PII with confidence scoring, masks only detections exceeding --min-confidence
(default 0.85), irreversibly scrubs original bytes via PyMuPDF redactions, replaces
each masked span with realistic Canadian mock PII (Faker en_CA), and saves the
anonymized PDFs to a designated output directory.

Usage:
  python anonymize_pdfs.py --input-dir ./canadian_docs --output-dir ./anonymized_docs
  python anonymize_pdfs.py --input-dir ./canadian_docs --output-dir ./anonymized_docs --min-confidence 0.85 --consistent --workers 8
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit(
        "Missing dependency: PyMuPDF ('fitz'). Install with: pip install -r requirements.txt"
    )

try:
    from faker import Faker
except ImportError:
    sys.exit(
        "Missing dependency: Faker. Install with: pip install -r requirements.txt"
    )

try:
    from tqdm import tqdm
except ImportError:
    tqdm = None  # Optional progress bar fallback


DEFAULT_MIN_CONFIDENCE = 0.85

SUPPORTED_ENTITIES = (
    "PERSON",
    "SIN",
    "CANADIAN_BANK_ACCOUNT",
    "ADDRESS",
    "PHONE",
    "EMAIL",
    "CREDIT_CARD",
    "DOB",
    "LEGAL_CASE_ID",
    "PASSPORT",
)


@dataclass(frozen=True)
class PiiMatch:
    entity_type: str
    text: str
    start: int
    end: int
    confidence: float


@dataclass
class FileReport:
    relative_path: str
    output_path: str
    pages: int
    entities_found: int
    entities_masked: int
    skipped_below_threshold: int
    entity_counts: Dict[str, int]
    elapsed_ms: int
    status: str
    error: Optional[str] = None
    mappings: Optional[List[Dict[str, str]]] = None


def luhn_valid(digits: str, min_len: int = 13, max_len: int = 19) -> bool:
    nums = [int(ch) for ch in digits if ch.isdigit()]
    if len(nums) < min_len or len(nums) > max_len:
        return False
    checksum = 0
    parity = len(nums) % 2
    for idx, digit in enumerate(nums):
        if idx % 2 == parity:
            digit *= 2
            if digit > 9:
                digit -= 9
        checksum += digit
    return checksum % 10 == 0


def sin_luhn_valid(raw: str) -> bool:
    digits = re.sub(r"\D", "", raw)
    if len(digits) != 9:
        return False
    # Canadian SINs do not start with 0 or 8
    if digits[0] in ("0", "8"):
        return False
    return luhn_valid(digits, min_len=9, max_len=9)


def make_luhn_sin(fake: Faker, original_value: str) -> str:
    """Generate a Luhn-valid synthetic 9-digit Canadian SIN (9xx test prefix)."""
    prefix = "9" + fake.numerify("#######")  # 8 digits
    nums = [int(c) for c in prefix]
    checksum = 0
    # 9-digit Luhn from right: check digit is index 8 (pos 1 from right)
    for idx, d in enumerate(nums):
        if idx % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        checksum += d
    check_digit = (10 - (checksum % 10)) % 10
    full = prefix + str(check_digit)
    if " " in original_value:
        return f"{full[0:3]} {full[3:6]} {full[6:9]}"
    return f"{full[0:3]}-{full[3:6]}-{full[6:9]}"


def make_luhn_card(fake: Faker, original_value: str) -> str:
    """Generate a Luhn-valid synthetic 16-digit Visa-prefixed card number."""
    prefix = "4" + fake.numerify("##############")
    digits = [int(c) for c in prefix]
    checksum = 0
    for idx, d in enumerate(digits):
        if idx % 2 == 0:
            d *= 2
            if d > 9:
                d -= 9
        checksum += d
    check_digit = (10 - (checksum % 10)) % 10
    full = prefix + str(check_digit)
    if "-" in original_value:
        return f"{full[0:4]}-{full[4:8]}-{full[8:12]}-{full[12:16]}"
    if " " in original_value:
        return f"{full[0:4]} {full[4:8]} {full[8:12]} {full[12:16]}"
    return full


# Canadian Provinces & Territories
CA_PROVINCE_RE = r"(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)"
CA_POSTAL_RE_STR = r"[ABCEGHJKLMNPRSTVXY]\d[ABCEGHJKLMNPRSTVWXYZ][ -]?\d[ABCEGHJKLMNPRSTVWXYZ]\d"

EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")

# Canadian SIN (XXX-XXX-XXX or XXX XXX XXX)
SIN_DASH_RE = re.compile(r"\b[1-79]\d{2}-\d{3}-\d{3}\b")
SIN_SPACE_RE = re.compile(r"\b[1-79]\d{2}\s\d{3}\s\d{3}\b")
SIN_LABELED_RE = re.compile(
    r"(?:(?:SIN|Social[ \t]+Insurance[ \t]+(?:Number|No\.?)|NAS)[ \t]*[:\-#]?[ \t]*)(\d{3}[ -]?\d{3}[ -]?\d{3})\b",
    re.IGNORECASE,
)

# Canadian & North American Phone Numbers
PHONE_FORMATTED_RE = re.compile(
    r"(?:(?:\+?1[-.\s]?)?(?:\(\d{3}\)[-.\s]?|\d{3}[-.\s])\d{3}[-.\s]\d{4})\b"
)
PHONE_COMPACT_RE = re.compile(r"\b(?:\+?1)?\d{10}\b")

CREDIT_CARD_RE = re.compile(r"\b(?:\d{4}[-\s]?){3}\d{4}\b|\b\d{13,19}\b")

# Canadian Bank Account, Transit, Institution, LIRA / RRSP / TFSA / Mortgage Numbers
BANK_TRANSIT_TUPLE_RE = re.compile(
    r"\b\d{5}[-\s]\d{3}[-\s]\d{7,12}\b"
)
BANK_LABELED_ACCOUNT_RE = re.compile(
    r"(?:(?:LIRA|RRSP|TFSA|RRIF|RESP|Account|Acct|Chequing|Savings|Mortgage|Policy|Contract|Transit|Institution|EFT)[ \t]*(?:No\.?|Number|#)?[ \t]*[:\-#][ \t]*)"
    r"([A-Z]{0,5}[-]?\d{3,14}(?:[- ]\d{2,12}){0,2})\b",
    re.IGNORECASE,
)

# Canadian Court File / Divorce Docket / CRA Business / Tax Reference Numbers
LEGAL_CASE_RE = re.compile(
    r"(?:(?:Court[ \t]*File|Docket|Action|Divorce[ \t]*File|Case|CRA[ \t]*(?:Ref|Payroll|Business)|Notice[ \t]*Ref)[ \t]*(?:No\.?|Number|#)?[ \t]*[:\-#][ \t]*)"
    r"([A-Z0-9]{2,6}(?:[- ][A-Z0-9]{2,10}){1,3})\b",
    re.IGNORECASE,
)
CRA_BN_RE = re.compile(r"\b\d{9}[ \t]?(?:RP|RC|RT|RR)[ \t]?\d{4}\b")

DOB_RE = re.compile(
    r"(?:(?:DOB|Date[ \t]+of[ \t]+Birth|Birth[ \t]*Date|Born|Date[ \t]+of[ \t]+Marriage|Separation[ \t]+Date)[ \t]*[:\-]?[ \t]*)("
    r"(?:0?[1-9]|1[0-2])[/\-](?:0?[1-9]|[12]\d|3[01])[/\-](?:19|20)\d{2}|"
    r"(?:19|20)\d{2}[/\-](?:0?[1-9]|1[0-2])[/\-](?:0?[1-9]|[12]\d|3[01])|"
    r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[ \t]+\d{1,2},?[ \t]+(?:19|20)\d{2}"
    r")",
    re.IGNORECASE,
)

# Canadian Street & Postal Code Addresses (English & French prefixes)
CA_STREET_SUFFIX = r"(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Way|Crescent|Cres|Parkway|Pkwy|Circle|Cir|Place|Pl|Trail|Tr|Terrace|Terr)"
CA_FR_PREFIX = r"(?:Rue|Avenue|Boulevard|Chemin|Allée|Impasse)"
ADDRESS_FULL_CA_RE = re.compile(
    rf"\b\d{{1,6}}[ \t]+(?:(?:{CA_FR_PREFIX})[ \t]+)?(?:[A-ZÀ-ÿ][a-zA-ZÀ-ÿ0-9.'-]+[ \t]+){{1,5}}"
    rf"(?:{CA_STREET_SUFFIX}\.?(?:[ \t]+(?:East|West|North|South|E|W|N|S|Ouest|Est|Nord|Sud))?)?"
    rf"(?:,[ \t]*(?:Apt|Suite|Ste|Unit|App|#)[ \t]*[A-Za-z0-9-]+)?"
    rf",[ \t]*[A-ZÀ-ÿ][a-zA-ZÀ-ÿ.\- ]+,[ \t]*{CA_PROVINCE_RE}[ \t]+{CA_POSTAL_RE_STR}\b"
)
ADDRESS_STREET_RE = re.compile(
    rf"\b\d{{1,6}}[ \t]+(?:[A-ZÀ-ÿ][a-zA-ZÀ-ÿ0-9.'-]+[ \t]+){{1,4}}"
    rf"{CA_STREET_SUFFIX}\.?(?:[ \t]+(?:East|West|North|South|E|W|N|S))?"
    rf"(?:,[ \t]*(?:Apt|Suite|Ste|Unit|App|#)[ \t]*[A-Za-z0-9-]+)?\b"
)
POSTAL_CODE_ONLY_RE = re.compile(rf"\b{CA_POSTAL_RE_STR}\b")

PASSPORT_RE = re.compile(
    r"(?:(?:Passport|DL|Driver'?s?[ \t]*Licen[cs]e|Ontario[ \t]*DL|ID[ \t]*No\.?)[ \t]*[:\-#]?[ \t]*)([A-Z0-9-]{6,18})\b",
    re.IGNORECASE,
)

PERSON_CONTEXT_RE = re.compile(
    r"(?:(?:Account[ \t]*Holder|Client|Customer|Employee(?:[ \t]*Name)?|Applicant|Petitioner|Respondent|Spouse|Former[ \t]*Spouse|Beneficiary|Contingent[ \t]*Beneficiary|Payor|Payee|Taxpayer|Trustee|Executor|Patient|Full[ \t]*Name|Name|Cardholder|Signed[ \t]*by|Prepared[ \t]*for|Requested[ \t]*by|Attn|Dear|Mr\.|Mrs\.|Ms\.|Dr\.)[ \t]*[:\-][ \t]*)"
    r"([A-ZÀ-ÿ][a-zà-ÿ]{1,20}(?:[ \t]+[A-Z]\.?)?[ \t]+[A-ZÀ-ÿ][a-zà-ÿ'-]{1,24}(?:[ \t]+[A-ZÀ-ÿ][a-zà-ÿ'-]{1,20})?)"
)
PERSON_STANDALONE_RE = re.compile(
    r"\b([A-Z][a-z]{2,18}(?:[ \t]+[A-Z]\.)?[ \t]+[A-Z][a-z'-]{2,22})\b"
)

COMMON_NON_PERSON_BIGRAMS = {
    "San Francisco",
    "New York",
    "North York",
    "Superior Court",
    "Family Court",
    "Notice Assessment",
    "Direct Deposit",
    "Payment Card",
    "Account Recovery",
    "Social Insurance",
    "Royal Bank",
    "Canada Revenue",
    "Revenue Agency",
    "Locked Retirement",
    "Gross Earnings",
    "Net Pay",
    "Bank Statement",
    "King Street",
    "Queen Street",
    "Yonge Street",
}


def detect_pii_regex(text: str, enabled_entities: Sequence[str]) -> List[PiiMatch]:
    enabled = set(enabled_entities)
    matches: List[PiiMatch] = []

    if "EMAIL" in enabled:
        for m in EMAIL_RE.finditer(text):
            matches.append(PiiMatch("EMAIL", m.group(0), m.start(), m.end(), 0.99))

    if "SIN" in enabled:
        for m in SIN_LABELED_RE.finditer(text):
            val = m.group(1)
            conf = 0.98 if sin_luhn_valid(val) else 0.90
            matches.append(PiiMatch("SIN", val, m.start(1), m.end(1), conf))
        for m in SIN_DASH_RE.finditer(text):
            val = m.group(0)
            if sin_luhn_valid(val):
                matches.append(PiiMatch("SIN", val, m.start(), m.end(), 0.96))
        for m in SIN_SPACE_RE.finditer(text):
            val = m.group(0)
            if sin_luhn_valid(val):
                matches.append(PiiMatch("SIN", val, m.start(), m.end(), 0.88))

    if "CREDIT_CARD" in enabled:
        for m in CREDIT_CARD_RE.finditer(text):
            raw = m.group(0)
            if luhn_valid(raw):
                matches.append(PiiMatch("CREDIT_CARD", raw, m.start(), m.end(), 0.98))

    if "CANADIAN_BANK_ACCOUNT" in enabled:
        for m in BANK_TRANSIT_TUPLE_RE.finditer(text):
            matches.append(PiiMatch("CANADIAN_BANK_ACCOUNT", m.group(0), m.start(), m.end(), 0.95))
        for m in BANK_LABELED_ACCOUNT_RE.finditer(text):
            matches.append(PiiMatch("CANADIAN_BANK_ACCOUNT", m.group(1), m.start(1), m.end(1), 0.93))

    if "LEGAL_CASE_ID" in enabled:
        for m in CRA_BN_RE.finditer(text):
            matches.append(PiiMatch("LEGAL_CASE_ID", m.group(0), m.start(), m.end(), 0.96))
        for m in LEGAL_CASE_RE.finditer(text):
            matches.append(PiiMatch("LEGAL_CASE_ID", m.group(1), m.start(1), m.end(1), 0.92))

    if "PHONE" in enabled:
        for m in PHONE_FORMATTED_RE.finditer(text):
            val = m.group(0).strip()
            if len(re.sub(r"\D", "", val)) >= 10:
                matches.append(PiiMatch("PHONE", val, m.start(), m.end(), 0.92))
        for m in PHONE_COMPACT_RE.finditer(text):
            val = m.group(0).strip()
            matches.append(PiiMatch("PHONE", val, m.start(), m.end(), 0.76))

    if "DOB" in enabled:
        for m in DOB_RE.finditer(text):
            matches.append(PiiMatch("DOB", m.group(1), m.start(1), m.end(1), 0.94))

    if "ADDRESS" in enabled:
        for m in ADDRESS_FULL_CA_RE.finditer(text):
            matches.append(PiiMatch("ADDRESS", m.group(0), m.start(), m.end(), 0.94))
        for m in ADDRESS_STREET_RE.finditer(text):
            matches.append(PiiMatch("ADDRESS", m.group(0), m.start(), m.end(), 0.88))
        for m in POSTAL_CODE_ONLY_RE.finditer(text):
            matches.append(PiiMatch("ADDRESS", m.group(0), m.start(), m.end(), 0.91))

    if "PASSPORT" in enabled:
        for m in PASSPORT_RE.finditer(text):
            matches.append(PiiMatch("PASSPORT", m.group(1), m.start(1), m.end(1), 0.90))

    if "PERSON" in enabled:
        for m in PERSON_CONTEXT_RE.finditer(text):
            candidate = m.group(1).strip()
            if len(candidate) >= 5:
                matches.append(PiiMatch("PERSON", candidate, m.start(1), m.end(1), 0.90))
        for m in PERSON_STANDALONE_RE.finditer(text):
            candidate = m.group(1).strip()
            if candidate not in COMMON_NON_PERSON_BIGRAMS and len(candidate) >= 6:
                matches.append(PiiMatch("PERSON", candidate, m.start(1), m.end(1), 0.78))

    matches.sort(key=lambda item: (item.start, -(item.end - item.start), -item.confidence))
    deduped: List[PiiMatch] = []
    last_end = -1
    for item in matches:
        if item.start >= last_end:
            deduped.append(item)
            last_end = item.end
    return deduped


def detect_pii_presidio(text: str, enabled_entities: Sequence[str]) -> List[PiiMatch]:
    """Optional Microsoft Presidio + spaCy NER engine merged with Canadian patterns."""
    matches = detect_pii_regex(text, enabled_entities)
    try:
        from presidio_analyzer import AnalyzerEngine  # type: ignore

        analyzer = AnalyzerEngine()
        entity_map = {
            "PERSON": "PERSON",
            "EMAIL": "EMAIL_ADDRESS",
            "PHONE": "PHONE_NUMBER",
            "CREDIT_CARD": "CREDIT_CARD",
            "DOB": "DATE_TIME",
            "ADDRESS": "LOCATION",
        }
        requested = [entity_map[e] for e in enabled_entities if e in entity_map]
        results = analyzer.analyze(text=text, entities=requested, language="en")
        reverse_map = {v: k for k, v in entity_map.items()}
        for res in results:
            etype = reverse_map.get(res.entity_type, res.entity_type)
            snippet = text[res.start : res.end]
            matches.append(PiiMatch(etype, snippet, res.start, res.end, float(res.score)))
    except Exception:
        pass

    matches.sort(key=lambda item: (item.start, -(item.end - item.start), -item.confidence))
    deduped: List[PiiMatch] = []
    last_end = -1
    for item in matches:
        if item.start >= last_end:
            deduped.append(item)
            last_end = item.end
    return deduped


def filter_by_confidence(
    matches: Sequence[PiiMatch], min_confidence: float
) -> Tuple[List[PiiMatch], int]:
    """Only retain PII detections whose confidence score strictly exceeds min_confidence."""
    accepted: List[PiiMatch] = []
    skipped = 0
    for match in matches:
        if match.confidence > min_confidence:
            accepted.append(match)
        else:
            skipped += 1
    return accepted, skipped


def generate_mock_pii(
    entity_type: str,
    original_value: str,
    mode: str,
    consistent: bool,
    seed: int,
    counter: int,
) -> str:
    if mode == "solid_mask":
        return f"[REDACTED:{entity_type}]"
    if mode == "token_replace":
        digest = hashlib.sha256(f"{seed}:{entity_type}:{original_value}".encode()).hexdigest()[:6].upper()
        return f"[{entity_type}_{digest}]"

    if consistent:
        key = f"{seed}:{entity_type}:{original_value.strip().lower()}".encode("utf-8")
    else:
        key = f"{seed}:{counter}:{time.time_ns()}:{original_value}".encode("utf-8")

    item_seed = int(hashlib.sha256(key).hexdigest()[:12], 16)
    fake = Faker("en_CA")
    fake.seed_instance(item_seed)

    if entity_type == "PERSON":
        return fake.name()
    if entity_type == "EMAIL":
        first = re.sub(r"[^a-z]", "", fake.first_name().lower()) or "alex"
        last = re.sub(r"[^a-z]", "", fake.last_name().lower()) or "tremblay"
        return f"{first}.{last}@example.ca"
    if entity_type == "PHONE":
        area = fake.random_element(["416", "647", "604", "778", "403", "587", "514", "613", "902"])
        exch = fake.random_int(min=200, max=999)
        line = fake.random_int(min=1000, max=9999)
        if original_value.startswith("+1"):
            return f"+1-{area}-{exch}-{line}"
        if "." in original_value:
            return f"{area}.{exch}.{line}"
        if "-" in original_value and "(" not in original_value:
            return f"{area}-{exch}-{line}"
        return f"({area}) {exch}-{line}"
    if entity_type == "SIN":
        return make_luhn_sin(fake, original_value)
    if entity_type == "CREDIT_CARD":
        return make_luhn_card(fake, original_value)
    if entity_type == "CANADIAN_BANK_ACCOUNT":
        if re.match(r"^\d{5}[-\s]\d{3}[-\s]\d{7,12}$", original_value):
            transit = fake.numerify("#####")
            inst = fake.random_element(["001", "002", "003", "004", "006", "010"])
            acct = fake.numerify("#######")
            sep = " " if " " in original_value else "-"
            return f"{transit}{sep}{inst}{sep}{acct}"
        prefix_match = re.match(r"^([A-Z]{2,5}-)", original_value)
        if prefix_match:
            return f"{prefix_match.group(1)}{fake.numerify('########')}"
        return fake.numerify("####-####-##")
    if entity_type == "LEGAL_CASE_ID":
        if re.match(r"^\d{9}", original_value):
            return f"{fake.numerify('#########')} RP 0001"
        return f"FS-{fake.random_int(min=20, max=26)}-{fake.numerify('#######')}-0000"
    if entity_type == "DOB":
        return fake.date_of_birth(minimum_age=21, maximum_age=78).strftime("%Y-%m-%d")
    if entity_type == "ADDRESS":
        if re.match(rf"^{CA_POSTAL_RE_STR}$", original_value.strip()):
            return fake.postalcode()
        if "," in original_value:
            return f"{fake.street_address()}, {fake.city()}, {fake.province_abbr()} {fake.postalcode()}"
        return fake.street_address()
    if entity_type == "PASSPORT":
        return fake.bothify("??######").upper()
    return "[MASKED]"


def estimate_font_size(page: "fitz.Page", rect: "fitz.Rect") -> float:
    """Estimate the original font size inside a bounding rectangle."""
    try:
        text_dict = page.get_text("dict", clip=rect)
        for block in text_dict.get("blocks", []):
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    size = float(span.get("size", 10.0))
                    if 5.0 <= size <= 36.0:
                        return size
    except Exception:
        pass
    return max(7.0, min(14.0, rect.height * 0.78))


def process_single_pdf(task: Tuple[str, str, str, dict]) -> FileReport:
    src_path_str, dst_path_str, rel_path, cfg = task
    t0 = time.perf_counter()
    entity_counts: Dict[str, int] = {}
    mappings: List[Dict[str, str]] = []
    total_found = 0
    total_masked = 0
    total_skipped = 0
    page_count = 0

    try:
        src_path = Path(src_path_str)
        dst_path = Path(dst_path_str)
        dst_path.parent.mkdir(parents=True, exist_ok=True)

        doc = fitz.open(src_path)
        page_count = len(doc)
        mode: str = cfg["mode"]
        consistent: bool = cfg["consistent"]
        seed: int = cfg["seed"]
        min_confidence: float = cfg["min_confidence"]
        enabled_entities: List[str] = cfg["entities"]
        engine: str = cfg["engine"]
        include_mapping: bool = cfg["include_mapping"]

        for page_index, page in enumerate(doc):
            page_text = page.get_text("text")
            if not page_text.strip():
                continue

            if engine == "presidio":
                raw_matches = detect_pii_presidio(page_text, enabled_entities)
            else:
                raw_matches = detect_pii_regex(page_text, enabled_entities)

            matches, skipped_page = filter_by_confidence(raw_matches, min_confidence)
            total_skipped += skipped_page

            if not matches:
                continue

            pending_replacements: List[Tuple[fitz.Rect, str, float]] = []
            seen_rects: List[fitz.Rect] = []

            for match in matches:
                total_found += 1
                entity_counts[match.entity_type] = entity_counts.get(match.entity_type, 0) + 1
                replacement = generate_mock_pii(
                    match.entity_type,
                    match.text,
                    mode,
                    consistent,
                    seed,
                    counter=total_found,
                )
                if include_mapping:
                    mappings.append(
                        {
                            "page": str(page_index + 1),
                            "entity_type": match.entity_type,
                            "confidence": f"{match.confidence:.2f}",
                            "original": match.text,
                            "replacement": replacement,
                        }
                    )

                rects = page.search_for(match.text)
                for rect in rects:
                    if any(rect.intersects(prev) for prev in seen_rects):
                        continue
                    seen_rects.append(rect)
                    font_size = estimate_font_size(page, rect)
                    fill_color = (0.06, 0.09, 0.16) if mode == "solid_mask" else (0.96, 0.97, 0.99)
                    if mode == "whiteout_replace":
                        fill_color = (1.0, 1.0, 1.0)
                    page.add_redact_annot(rect, text="", fill=fill_color)
                    pending_replacements.append((rect, replacement, font_size))
                    total_masked += 1

            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

            for rect, replacement, font_size in pending_replacements:
                if mode == "solid_mask":
                    fit_size = max(5.5, min(font_size * 0.85, 10.0))
                    page.insert_textbox(
                        rect,
                        replacement,
                        fontsize=fit_size,
                        fontname="helv",
                        color=(0.98, 0.98, 0.99),
                        align=fitz.TEXT_ALIGN_LEFT,
                    )
                else:
                    if mode == "mask_and_replace":
                        page.draw_rect(rect, color=(0.82, 0.86, 0.92), width=0.4)
                    expanded = fitz.Rect(
                        rect.x0,
                        rect.y0 - 1,
                        max(rect.x1, rect.x0 + len(replacement) * font_size * 0.56),
                        rect.y1 + 1,
                    )
                    fit_size = font_size
                    while fit_size > 6.0:
                        rc = page.insert_textbox(
                            expanded,
                            replacement,
                            fontsize=fit_size,
                            fontname="helv",
                            color=(0.06, 0.09, 0.16),
                            align=fitz.TEXT_ALIGN_LEFT,
                        )
                        if rc >= 0:
                            break
                        fit_size -= 0.75

        doc.save(dst_path, garbage=4, deflate=True, clean=True)
        doc.close()

        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        return FileReport(
            relative_path=rel_path,
            output_path=str(dst_path),
            pages=page_count,
            entities_found=total_found,
            entities_masked=total_masked,
            skipped_below_threshold=total_skipped,
            entity_counts=entity_counts,
            elapsed_ms=elapsed_ms,
            status="completed",
            mappings=mappings if include_mapping else None,
        )
    except Exception as exc:
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        return FileReport(
            relative_path=rel_path,
            output_path=dst_path_str,
            pages=page_count,
            entities_found=total_found,
            entities_masked=total_masked,
            skipped_below_threshold=total_skipped,
            entity_counts=entity_counts,
            elapsed_ms=elapsed_ms,
            status="error",
            error=str(exc),
        )


def collect_pdfs(input_dir: Path, recursive: bool) -> List[Path]:
    pattern = "**/*.pdf" if recursive else "*.pdf"
    files = [p for p in input_dir.glob(pattern) if p.is_file()]
    files.sort()
    return files


def confidence_float(value: str) -> float:
    parsed = float(value)
    if not (0.0 <= parsed <= 1.0):
        raise argparse.ArgumentTypeError("--min-confidence must be between 0.0 and 1.0")
    return parsed


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Canadian Banking & Legal Batch PDF PII anonymizer (1 to 1,000+ PDFs)."
    )
    parser.add_argument("--input-dir", required=True, help="Directory containing input PDF files.")
    parser.add_argument("--output-dir", required=True, help="Directory where anonymized PDFs will be saved.")
    parser.add_argument("--recursive", action="store_true", help="Recursively scan subdirectories for PDFs.")
    parser.add_argument(
        "--mode",
        choices=("mask_and_replace", "whiteout_replace", "solid_mask"),
        default="mask_and_replace",
        help="Masking and replacement strategy.",
    )
    parser.add_argument(
        "--entities",
        default=",".join(SUPPORTED_ENTITIES),
        help=f"Comma-separated PII entity types (default: {','.join(SUPPORTED_ENTITIES)}).",
    )
    parser.add_argument(
        "--min-confidence",
        type=confidence_float,
        default=DEFAULT_MIN_CONFIDENCE,
        help=(
            f"Minimum PII confidence threshold in [0.0, 1.0] (default: {DEFAULT_MIN_CONFIDENCE}). "
            "Only detections with confidence strictly greater than this threshold are masked."
        ),
    )
    parser.add_argument(
        "--consistent",
        action="store_true",
        help="Deterministically map identical PII values to the same mock replacement across all files.",
    )
    parser.add_argument("--seed", type=int, default=42, help="Random seed for mock PII generation.")
    parser.add_argument(
        "--workers",
        type=int,
        default=min(8, os.cpu_count() or 4),
        help="Number of parallel worker processes for batch execution.",
    )
    parser.add_argument(
        "--engine",
        choices=("regex", "presidio"),
        default="regex",
        help="Detection engine ('regex' is zero-download; 'presidio' adds spaCy NER if installed).",
    )
    parser.add_argument(
        "--manifest",
        default="anonymization_manifest.json",
        help="Filename or path for the batch audit report JSON inside output-dir.",
    )
    parser.add_argument(
        "--include-mapping",
        action="store_true",
        help="Include original->mock mapping table in manifest (use only in secure audit environments).",
    )
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args()
    input_dir = Path(args.input_dir).resolve()
    output_dir = Path(args.output_dir).resolve()

    if not input_dir.is_dir():
        print(f"Error: Input directory does not exist: {input_dir}", file=sys.stderr)
        return 1

    output_dir.mkdir(parents=True, exist_ok=True)
    pdf_files = collect_pdfs(input_dir, args.recursive)
    if not pdf_files:
        print(f"No PDF files found in {input_dir}")
        return 0

    entities = [e.strip().upper() for e in args.entities.split(",") if e.strip()]
    cfg = {
        "mode": args.mode,
        "consistent": bool(args.consistent),
        "seed": int(args.seed),
        "min_confidence": float(args.min_confidence),
        "entities": entities,
        "engine": args.engine,
        "include_mapping": bool(args.include_mapping),
    }

    tasks: List[Tuple[str, str, str, dict]] = []
    for src in pdf_files:
        rel = src.relative_to(input_dir)
        dst = output_dir / rel
        tasks.append((str(src), str(dst), str(rel), cfg))

    print(
        f"Processing {len(tasks)} Canadian PDF(s) with {args.workers} worker(s) "
        f"[min_confidence > {args.min_confidence:.2f}] -> {output_dir}"
    )
    t_start = time.perf_counter()
    reports: List[FileReport] = []

    if len(tasks) == 1 or args.workers <= 1:
        iterator: Iterable = tqdm(tasks, desc="Anonymizing PDFs") if tqdm else tasks
        for task in iterator:
            reports.append(process_single_pdf(task))
    else:
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(process_single_pdf, t) for t in tasks]
            iterator = (
                tqdm(as_completed(futures), total=len(futures), desc="Anonymizing PDFs")
                if tqdm
                else as_completed(futures)
            )
            for fut in iterator:
                reports.append(fut.result())

    reports.sort(key=lambda r: r.relative_path)
    total_elapsed = round(time.perf_counter() - t_start, 2)
    succeeded = sum(1 for r in reports if r.status == "completed")
    failed = len(reports) - succeeded
    total_masked = sum(r.entities_masked for r in reports)
    total_skipped = sum(r.skipped_below_threshold for r in reports)

    manifest_path = Path(args.manifest)
    if not manifest_path.is_absolute():
        manifest_path = output_dir / manifest_path

    manifest_payload = {
        "input_dir": str(input_dir),
        "output_dir": str(output_dir),
        "mode": args.mode,
        "min_confidence": args.min_confidence,
        "consistent": bool(args.consistent),
        "seed": args.seed,
        "total_files": len(reports),
        "succeeded": succeeded,
        "failed": failed,
        "total_pii_masked": total_masked,
        "total_skipped_below_threshold": total_skipped,
        "elapsed_seconds": total_elapsed,
        "files": [asdict(r) for r in reports],
    }
    manifest_path.write_text(json.dumps(manifest_payload, indent=2), encoding="utf-8")

    print(
        f"Done in {total_elapsed}s: {succeeded}/{len(reports)} files anonymized, "
        f"{total_masked} PII spans masked & replaced ({total_skipped} skipped below threshold). "
        f"Manifest: {manifest_path}"
    )
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
