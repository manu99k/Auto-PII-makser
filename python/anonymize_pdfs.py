#!/usr/bin/env python3
"""
Canadian Banking & Legal Batch PDF PII Anonymizer (1 to 1,000+ PDFs)
--------------------------------------------------------------------
Reads Canadian English & French banking, wealth (LIRA/RRSP/TFSA/RESP/FHSA/RDSP/
REER/FERR/CELI/REEE/CRI/FRV/CELIAPP), payroll (payslips), tax (CRA / Revenu Québec),
and family law (divorce decrees, separation agreements) PDFs from an input folder,
identifies PII with confidence scoring, ignores CIBC employee/branch contact PII by
default while redacting customer PII, masks only detections exceeding --min-confidence
(default 0.85), irreversibly scrubs original bytes & clickable link annotations via
PyMuPDF redactions, replaces each masked span with format-preserving Canadian mock
PII (Faker en_CA), and saves the anonymized PDFs to a designated output directory.

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
import unicodedata
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

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


def fold_accents(value: str) -> str:
    return "".join(
        ch for ch in unicodedata.normalize("NFD", value) if unicodedata.category(ch) != "Mn"
    )


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
    """Generate a Luhn-valid synthetic 9-digit Canadian SIN (9xx test prefix) preserving separator."""
    prefix = "9" + fake.numerify("#######")
    nums = [int(c) for c in prefix]
    checksum = 0
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
    if "-" in original_value:
        return f"{full[0:3]}-{full[3:6]}-{full[6:9]}"
    return full


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


KNOWN_ID_PREFIX_RE = re.compile(
    r"^(LIRA|RRSP|TFSA|RRIF|RESP|RDSP|FHSA|LIF|PRPP|SPP|REER|FERR|CELI|REEE|CRI|FRV|REEI|CELIAPP|RPDB|CRA|FS)-",
    re.IGNORECASE,
)


def preserve_format_mock(fake: Faker, original: str, keep_known_prefix: bool = False) -> str:
    """Preserve exact digits, uppercase/lowercase letters, and separators (e.g. 123456 -> 591042)."""
    prefix = ""
    body = original
    if keep_known_prefix:
        m = KNOWN_ID_PREFIX_RE.match(original)
        if m:
            prefix = m.group(0).upper()
            body = original[len(prefix) :]

    chars: List[str] = []
    for idx, ch in enumerate(body):
        if ch.isdigit():
            min_d = 1 if (idx == 0 and ch != "0") else 0
            chars.append(str(fake.random_int(min=min_d, max=9)))
        elif "A" <= ch <= "Z":
            chars.append(fake.random_uppercase_letter())
        elif "a" <= ch <= "z":
            chars.append(fake.random_lowercase_letter())
        else:
            chars.append(ch)

    result = prefix + "".join(chars)
    if result == original and body:
        for i, ch in enumerate(chars):
            if ch.isdigit():
                chars[i] = str((int(ch) + 3) % 10)
                return prefix + "".join(chars)
    return result


# Canadian Provinces & Territories
CA_PROVINCE_RE = r"(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)"
CA_POSTAL_RE_STR = r"[ABCEGHJKLMNPRSTVXY]\d[ABCEGHJKLMNPRSTVWXYZ][ -]?\d[ABCEGHJKLMNPRSTVWXYZ]\d"

EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
CIBC_EMAIL_DOMAIN_RE = re.compile(r"@(?:[a-z0-9-]+\.)*cibc\.(?:com|ca)$", re.IGNORECASE)

# Canadian SIN / NAS (XXX-XXX-XXX or XXX XXX XXX)
SIN_DASH_RE = re.compile(r"\b[1-79]\d{2}-\d{3}-\d{3}\b")
SIN_SPACE_RE = re.compile(r"\b[1-79]\d{2} \d{3} \d{3}\b")
SIN_LABELED_RE = re.compile(
    r"(?:(?:SIN|NAS|Social[ \t]+Insurance[ \t]+(?:Number|No\.?)|Num[eé]ro[ \t]+d['’]assurance[ \t]+sociale|N[°o]?[ \t]*d['’]assurance[ \t]+sociale)[ \t]*(?:[:\-#][ \t]*|\n[ \t]*))(\d{3}[ -]?\d{3}[ -]?\d{3})\b",
    re.IGNORECASE,
)

# Canadian & North American Phone Numbers
PHONE_FORMATTED_RE = re.compile(
    r"(?:(?:\+?1[-.\s]?)?(?:\(\d{3}\)[-.\s]?|\d{3}[-.\s])\d{3}[-.\s]\d{4})\b"
)
PHONE_COMPACT_RE = re.compile(r"\b(?:\+?1)?\d{10}\b")

CREDIT_CARD_RE = re.compile(r"\b(?:\d{4}[-\s]?){3}\d{4}\b|\b\d{13,19}\b")

# Canadian Bank Account, Transit, Institution, English & French Registered Plan / Account IDs
BANK_TRANSIT_TUPLE_RE = re.compile(r"\b\d{5}[-\s]\d{3}[-\s]\d{7,12}\b")
BANK_LABELED_ACCOUNT_RE = re.compile(
    r"(?:(?:LIRA|RRSP|TFSA|RRIF|RESP|RDSP|FHSA|LIF|PRPP|SPP|REER|FERR|CELI|REEE|CRI|FRV|REEI|CELIAPP|RPDB|Receiving[ \t]+Plan|Relinquishing[ \t]+Plan|Plan|Account|Acct|Chequing|Savings|Mortgage|Policy|Contract|Certificate|Client[ \t]*ID|Member|Transit|Institution|EFT|Num[eé]ro[ \t]+de[ \t]+compte|N[°o]?[ \t]+de[ \t]+compte|Num[eé]ro[ \t]+de[ \t]+r[eé]gime|N[°o]?[ \t]+de[ \t]+r[eé]gime|Num[eé]ro[ \t]+de[ \t]+contrat|Num[eé]ro[ \t]+de[ \t]+police|Num[eé]ro[ \t]+client|Num[eé]ro[ \t]+de[ \t]+membre|Compte|R[eé]gime|Contrat|Police|Succursale|NEQ)[ \t]*(?:No\.?|Number|#)?[ \t]*(?:[:\-#][ \t]*|[ \t]*\n[ \t]*))"
    r"([A-Z]{0,5}[-]?\d{3,14}(?:[- ]\d{1,12}){0,3}|[A-Z]{1,4}\d{4,12})\b",
    re.IGNORECASE,
)

# Canadian Court File / Divorce Docket / CRA & Revenu Quebec Business / Tax Reference Numbers
LEGAL_CASE_RE = re.compile(
    r"(?:(?:Court[ \t]*File|Docket|Action|Divorce[ \t]*File|Case|CRA[ \t]*(?:Ref|Payroll|Business)|Notice[ \t]*Ref|Num[eé]ro[ \t]+de[ \t]+dossier|Dossier[ \t]+de[ \t]+la[ \t]+cour|Dossier|R[eé]f[eé]rence[ \t]+(?:ARC|Revenu[ \t]+Qu[eé]bec)|N[°o]?[ \t]+d['’]avis)[ \t]*(?:No\.?|Number|#)?[ \t]*(?:[:\-#][ \t]*|[ \t]*\n[ \t]*))"
    r"([A-Z0-9]{2,6}(?:[- ][A-Z0-9]{2,10}){1,3})\b",
    re.IGNORECASE,
)
CRA_BN_RE = re.compile(r"\b\d{9}[ \t]?(?:RP|RC|RT|RR|RQ)[ \t]?\d{4}\b")

FR_MONTHS_RE = r"(?:janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)"
EN_MONTHS_RE = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*"

DOB_RE = re.compile(
    rf"(?:(?:DOB|Date[ \t]+of[ \t]+Birth|Birth[ \t]*Date|Born|Date[ \t]+of[ \t]+Marriage|Separation[ \t]+Date|Date[ \t]+de[ \t]+naissance|DDN|N[eé]e?[ \t]+le|Date[ \t]+de[ \t]+mariage|Date[ \t]+de[ \t]+s[eé]paration|Date[ \t]+de[ \t]+rupture)[ \t]*(?:[:\-][ \t]*|\n[ \t]*))("
    r"(?:0?[1-9]|1[0-2])[/\-](?:0?[1-9]|[12]\d|3[01])[/\-](?:19|20)\d{2}|"
    r"(?:19|20)\d{2}[/\-](?:0?[1-9]|1[0-2])[/\-](?:0?[1-9]|[12]\d|3[01])|"
    rf"{EN_MONTHS_RE}[ \t]+\d{{1,2}},?[ \t]+(?:19|20)\d{{2}}|"
    rf"\d{{1,2}}[ \t]+{FR_MONTHS_RE}[ \t]+(?:19|20)\d{{2}}"
    r")",
    re.IGNORECASE,
)

# Canadian Street & Postal Code Addresses (English & French prefixes)
CA_STREET_SUFFIX = r"(?:Street|St|Avenue|Ave|Boulevard|Blvd|Boul|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Way|Crescent|Cres|Parkway|Pkwy|Circle|Cir|Place|Pl|Trail|Tr|Terrace|Terr|Terrasse|Croissant|Promenade|Sentier)"
CA_FR_PREFIX = r"(?:Rue|Avenue|Boulevard|Boul\.?|Chemin|Ch\.?|Allée|Allee|Impasse|Place|Rang|Route|Côte|Cote|Carré|Carre)"
ADDRESS_FULL_CA_RE = re.compile(
    rf"\b\d{{1,6}}[ \t]+(?:(?:{CA_FR_PREFIX})[ \t]+)?(?:[A-ZÀ-Ÿ][a-zA-ZÀ-ÿ0-9.'-]+[ \t]+){{1,5}}"
    rf"(?:{CA_STREET_SUFFIX}\.?(?:[ \t]+(?:East|West|North|South|E|W|N|S|Ouest|Est|Nord|Sud))?)?"
    rf"(?:,[ \t]*(?:Apt|Suite|Ste|Unit|App\.?|Appartement|Bureau|Unit[eé]|#)[ \t]*[A-Za-z0-9-]+)?"
    rf",[ \t]*[A-ZÀ-Ÿ][a-zA-ZÀ-ÿ.\- ]+,[ \t]*{CA_PROVINCE_RE}[ \t]+{CA_POSTAL_RE_STR}(?:,[ \t]*Canada)?\b"
)
ADDRESS_STREET_RE = re.compile(
    rf"\b\d{{1,6}}[ \t]+(?:(?:{CA_FR_PREFIX})[ \t]+)?(?:[A-ZÀ-Ÿ][a-zA-ZÀ-ÿ0-9.'-]+[ \t]+){{1,4}}"
    rf"{CA_STREET_SUFFIX}\.?(?:[ \t]+(?:East|West|North|South|E|W|N|S|Ouest|Est|Nord|Sud))?"
    rf"(?:,[ \t]*(?:Apt|Suite|Ste|Unit|App\.?|Appartement|Bureau|Unit[eé]|#)[ \t]*[A-Za-z0-9-]+)?\b"
)
ADDRESS_FR_LINE_RE = re.compile(
    rf"\b\d{{1,6}}(?:,[ \t]*|[ \t]+){CA_FR_PREFIX}[ \t]+[A-ZÀ-Ÿa-zà-ÿ0-9.'-]+(?:[ \t]+[A-ZÀ-Ÿa-zà-ÿ0-9.'-]+){{0,4}}(?:,[ \t]*(?:App\.?|Appartement|Bureau|Suite|#)[ \t]*[A-Za-z0-9-]+)?\b"
)
POSTAL_CODE_ONLY_RE = re.compile(rf"\b{CA_POSTAL_RE_STR}\b")

PASSPORT_RE = re.compile(
    r"(?:(?:Passport|Passeport|DL|Driver'?s?[ \t]*Licen[cs]e|Ontario[ \t]*DL|Permis[ \t]+de[ \t]+conduire|ID[ \t]*No\.?)[ \t]*[:\-#]?[ \t]*)([A-Z0-9-]{6,18})\b",
    re.IGNORECASE,
)

NAME_PART_TITLE = r"[A-ZÀ-Ÿ][a-zà-ÿ'-]{1,22}(?:-[A-ZÀ-Ÿ][a-zà-ÿ'-]{1,22})?"
NAME_PART_CAPS = r"[A-ZÀ-Ÿ]{2,20}(?:-[A-ZÀ-Ÿ]{2,20})?"
NAME_PART_ANY = rf"(?:{NAME_PART_TITLE}|{NAME_PART_CAPS})"

PERSON_LABELS_COLON = (
    r"(?:Account[ \t]*Holder|Client(?:[ \t]*Name)?|Customer(?:[ \t]*Name)?|Employee(?:[ \t]*Name)?|"
    r"Applicant|Petitioner|Respondent|Spouse|Former[ \t]*Spouse|Beneficiary|Contingent[ \t]*Beneficiary|"
    r"Subscriber|Joint[ \t]*Subscriber|Plan[ \t]*Holder|Holder|Annuitant|Contributor|"
    r"Legal[ \t]*Name(?:[ \t]+of[ \t]+[^:\n]{1,35})?|Payor|Payee|Taxpayer|Trustee|Executor|Patient|"
    r"Full[ \t]*Name|First[ \t]*Name|Last[ \t]*Name|Given[ \t]*Name|Surname|Name|Cardholder|"
    r"Signed[ \t]*by|Prepared[ \t]*for|Requested[ \t]*by|Attn|Dear|Mr\.|Mrs\.|Ms\.|Dr\.|Contact[ \t]*Name|"
    r"Nom[ \t]+du[ \t]+client|Nom[ \t]+complet|Nom[ \t]+et[ \t]+pr[eé]nom|Pr[eé]nom[ \t]+et[ \t]+nom|"
    r"Pr[eé]nom|Nom[ \t]+de[ \t]+famille|Titulaire(?:[ \t]+du[ \t]+(?:compte|r[eé]gime))?|Cotitulaire|"
    r"Souscripteur|Rentier|B[eé]n[eé]ficiaire|Conjoint(?:e)?|Ex-conjoint(?:e)?|Demandeur|D[eé]fendeur|"
    r"D[eé]biteur|Contribuable|Fiduciaire|Liquidateur|Employ[eé]e?|Sign[eé][ \t]+par|Pr[eé]par[eé][ \t]+pour|"
    r"[ÀA][ \t]+l['’]attention[ \t]+de|Monsieur|Madame|M\.|Mme|Mlle|Personne-ressource)"
)
PERSON_LABELS_NEWLINE = (
    r"(?:\*?[ \t]*(?:Account[ \t]*Holder|Client[ \t]*Name|Full[ \t]*Name|Subscriber[ \t]*Name|"
    r"Annuitant[ \t]*Name|Beneficiary[ \t]*Name|Contact[ \t]*Name|First[ \t]*Name|Last[ \t]*Name|"
    r"Nom[ \t]+du[ \t]+client|Nom[ \t]+complet|Pr[eé]nom[ \t]+et[ \t]+nom|Titulaire[ \t]+du[ \t]+compte|"
    r"Souscripteur|B[eé]n[eé]ficiaire))"
)

PERSON_CONTEXT_RE = re.compile(
    rf"(?:{PERSON_LABELS_COLON}[ \t]*[:\-][ \t]*|{PERSON_LABELS_NEWLINE}[ \t]*\n[ \t]*)"
    rf"({NAME_PART_ANY}(?:[ \t]+[A-ZÀ-Ÿ]\.?)?[ \t]+{NAME_PART_ANY}(?:[ \t]+{NAME_PART_ANY})?)"
)
PERSON_STANDALONE_RE = re.compile(
    rf"\b({NAME_PART_TITLE}(?:[ \t]+[A-Z]\.)?[ \t]+{NAME_PART_TITLE}|{NAME_PART_CAPS}(?:[ \t]+[A-Z]\.)?[ \t]+{NAME_PART_CAPS})\b"
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
    "Revenu Quebec",
    "Locked Retirement",
    "Gross Earnings",
    "Net Pay",
    "Bank Statement",
    "King Street",
    "Queen Street",
    "Yonge Street",
    "Mutual Funds",
    "Savings Plan",
    "Beneficiary Plan",
    "Family Beneficiary",
    "Registered Education",
    "Branch Contact",
    "Contact Information",
    "Client Instructions",
    "Client Information",
    "In Cash",
    "Common Law",
    "Registered Investments",
}

COMMON_NON_PERSON_WORDS = {
    "account", "number", "type", "plan", "mutual", "funds", "fund", "savings", "education",
    "registered", "family", "beneficiary", "statement", "period", "balance", "opening",
    "closing", "change", "value", "total", "investments", "investment", "contributions",
    "contribution", "summary", "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december", "bank", "royal",
    "canada", "canadian", "toronto", "dominion", "montreal", "vancouver", "calgary",
    "ottawa", "ontario", "quebec", "alberta", "british", "columbia", "manitoba",
    "saskatchewan", "street", "avenue", "boulevard", "road", "drive", "suite", "north",
    "south", "east", "west", "direct", "deposit", "tax", "federal", "provincial",
    "notice", "assessment", "superior", "court", "justice", "divorce", "order", "rules",
    "pay", "gross", "net", "deductions", "earnings", "page", "your", "have", "question",
    "need", "know", "glance", "amount", "date", "detail", "details", "information",
    "profile", "contact", "address", "phone", "email", "postal", "code", "transit",
    "branch", "institution", "chequing", "mortgage", "income", "return", "limit",
    "deduction", "year", "month", "resp", "tfsa", "rrsp", "lira", "rrif", "rdsp", "fhsa",
    "lif", "prpp", "spp", "qesi", "tisa", "gic", "cibc", "investors", "investor", "wood",
    "gundy", "scotiabank", "scotia", "desjardins", "laurentienne", "bmo", "rbc", "bnc",
    "interest", "rate", "market", "unit", "units", "price", "fees", "fee", "service",
    "services", "client", "clients", "instructions", "banking", "centre", "transfers",
    "transfer", "within", "refers", "other", "financial", "institutions", "cash", "kind",
    "corporate", "estate", "trust", "partnership", "individual", "joint", "part",
    "authorization", "record", "locked", "retirement", "holder", "consent", "form",
    "breakdown", "marriage", "common", "law", "subparagraph", "subsection", "section",
    "single", "supporting", "documents", "document", "incentive", "relinquishing",
    "receiving", "legal", "business", "city", "province", "country",
    "compte", "titulaire", "souscripteur", "beneficiaire", "rentier", "conjoint", "conjointe",
    "regime", "epargne", "retraite", "etudes", "transfert", "formulaire", "renseignements",
    "succursale", "coordonnees", "banque", "placements", "revenu", "numero", "assurance",
    "sociale", "adresse", "ville", "telephone", "courriel", "naissance", "mariage",
    "rupture", "separation", "montant", "solde", "periode", "releve", "instruction",
    "particulier", "entreprise", "fiducie", "societe", "mandat", "procuration",
    "signature", "annexe", "partie", "reer", "ferr", "celi", "reee", "cri", "frv",
    "reei", "celiapp", "rpdb", "iqee", "caisse", "nationale", "epargnes", "enregistre",
    "enregistree", "non", "oui", "janvier", "fevrier", "mars", "avril", "mai", "juin",
    "juillet", "aout", "septembre", "octobre", "novembre", "decembre", "personne",
    "ressource", "representant", "conseiller", "directeur",
}

COMMON_FIRST_NAMES = {
    "aaron", "abigail", "adam", "adrian", "aidan", "aiden", "alain", "alan", "albert", "alex",
    "alexander", "alexandra", "alexandre", "alexis", "alice", "alicia", "alison", "allison",
    "amanda", "amber", "amelia", "amelie", "amy", "andre", "andrea", "andrew", "angela", "anna",
    "anne", "annie", "anthony", "antoine", "aria", "ariel", "arthur", "ashley", "aubrey", "audrey",
    "austin", "ava", "avery", "barbara", "beatrice", "benjamin", "benoit", "bernard", "bethany",
    "blake", "brandon", "brenda", "brian", "brianna", "brigitte", "brittany", "brooke", "brooklyn",
    "bruce", "bryan", "caleb", "cameron", "camila", "camille", "carl", "carole", "caroline",
    "carter", "catherine", "chantal", "charles", "charlotte", "chase", "chloe", "christian",
    "christina", "christine", "christopher", "claire", "clara", "claude", "claudette", "cole",
    "colette", "colin", "connor", "cooper", "cynthia", "daniel", "danielle", "david", "dean",
    "deborah", "denis", "denise", "derek", "diana", "diane", "dominic", "dominique", "donald",
    "donna", "dorothy", "douglas", "dylan", "edward", "eleanor", "elena", "elijah", "elise",
    "elizabeth", "ella", "ellen", "ellie", "elliot", "emilia", "emilie", "emily", "emma", "eric",
    "erica", "erik", "erin", "ethan", "etienne", "eugene", "eva", "evan", "evelyn", "faith",
    "felix", "fiona", "florence", "frances", "francine", "francis", "francois", "frank",
    "frederick", "gabriel", "gabrielle", "gaetan", "gary", "gavin", "genevieve", "george",
    "gerald", "gianna", "gilles", "grace", "graham", "grant", "gregory", "guillaume", "hailey",
    "hannah", "harold", "harper", "harrison", "harry", "hayden", "hazel", "heather", "helen",
    "helene", "henri", "henry", "holly", "howard", "hugo", "hunter", "ian", "isaac", "isabella",
    "isabelle", "jack", "jackson", "jacob", "jacqueline", "jacques", "jade", "james", "jamie",
    "jane", "janet", "janice", "jared", "jason", "jayden", "jean", "jean-francois", "jean-luc",
    "jean-marc", "jean-pierre", "jeanne", "jeffrey", "jennifer", "jeremy", "jerome", "jerry",
    "jesse", "jessica", "jill", "joan", "joanne", "jocelyn", "jocelyne", "joe", "joel",
    "johanne", "john", "jonathan", "jordan", "josee", "joseph", "joshua", "joyce", "juan",
    "judith", "judy", "julia", "julian", "julie", "julien", "juliette", "justin", "karen",
    "katherine", "kathleen", "kathryn", "katie", "kayla", "keith", "kelly", "kenneth", "kevin",
    "kimberly", "kyle", "laura", "laurence", "lauren", "laurent", "lawrence", "layla", "lea",
    "leah", "leilani", "leo", "leonard", "leslie", "liam", "lillian", "lily", "linda", "lindsay",
    "lisa", "lise", "logan", "lori", "louis", "louise", "luc", "lucas", "lucie", "lucy", "luke",
    "luna", "lyne", "lynn", "madeleine", "madeline", "madison", "manon", "marc", "marcus",
    "margaret", "marguerite", "maria", "marianne", "marie", "marie-claire", "marie-eve",
    "marie-pier", "marilyn", "mario", "mark", "martha", "martin", "martine", "mary", "mason",
    "mateo", "mathieu", "matthew", "maureen", "max", "maxime", "maya", "megan", "melanie",
    "melissa", "mia", "michael", "michel", "michele", "michelle", "mila", "miles", "mitchell",
    "molly", "monica", "monique", "morgan", "nadia", "nancy", "naomi", "natalie", "nathalie",
    "nathan", "nathaniel", "neil", "nicholas", "nicolas", "nicole", "noah", "noemie", "nolan",
    "nora", "norman", "odette", "oliver", "olivia", "olivier", "owen", "paige", "pamela",
    "parker", "pascal", "patricia", "patrick", "paul", "paula", "paule", "pauline", "penelope",
    "peter", "philip", "philippe", "pierre", "pierrette", "rachel", "ralph", "randall",
    "raphael", "raymond", "real", "rebecca", "regina", "rejean", "remi", "rene", "renee",
    "richard", "riley", "robert", "robin", "roger", "roland", "ronald", "rosalie", "rose",
    "rosemarie", "ross", "roy", "ruby", "russell", "ruth", "ryan", "sabrina", "samantha",
    "samuel", "sandra", "sandrine", "sara", "sarah", "savannah", "scarlett", "scott", "sean",
    "sebastian", "sebastien", "serge", "sharon", "shawn", "sheila", "shelby", "shirley",
    "simon", "sofia", "sophia", "sophie", "spencer", "stacy", "stanley", "stella", "stephane",
    "stephanie", "stephen", "steve", "steven", "stuart", "susan", "suzanne", "sydney",
    "sylvain", "sylvia", "sylvie", "tammy", "tanya", "tara", "taylor", "teresa", "terry",
    "theresa", "thierry", "thomas", "timothy", "tina", "todd", "tom", "tony", "tracy", "travis",
    "trevor", "troy", "tyler", "valerie", "vanessa", "veronique", "victor", "victoria",
    "vincent", "violet", "virginia", "virginie", "walter", "wanda", "warren", "wayne", "wendy",
    "wesley", "william", "willow", "wyatt", "xavier", "yves", "yvon", "zachary", "zoe", "zoey",
}

ZONE_START_RE = re.compile(
    r"(?:Branch[ \t]+Contact[ \t]+Information|CIBC[ \t]+(?:Branch[ \t]+)?Contact(?:[ \t]+Information)?|"
    r"CIBC[ \t]+Representative|CIBC[ \t]+Advisor|Coordonn[eé]es[ \t]+de[ \t]+la[ \t]+succursale|"
    r"Renseignements[ \t]+sur[ \t]+(?:le[ \t]+contact[ \t]+de[ \t]+)?la[ \t]+succursale|"
    r"Conseiller[ \t]+CIBC|Repr[eé]sentant[ \t]+CIBC)",
    re.IGNORECASE,
)
ZONE_END_RE = re.compile(
    r"(?:Client[ \t]+Information|Account[ \t]+Holder|Corporate\/|Investor[ \t]+Information|"
    r"Subscriber[ \t]+Information|Plan[ \t]+Holder|Relinquishing[ \t]+Institution|"
    r"Renseignements[ \t]+sur[ \t]+le[ \t]+client|Titulaire[ \t]+du[ \t]+compte|Souscripteur)",
    re.IGNORECASE,
)


def extract_cibc_context(text: str) -> Tuple[Set[str], List[Tuple[int, int]]]:
    cibc_names: Set[str] = set()
    cibc_zones: List[Tuple[int, int]] = []

    for em in EMAIL_RE.finditer(text):
        email = em.group(0)
        if CIBC_EMAIL_DOMAIN_RE.search(email):
            local = email.split("@")[0]
            cleaned = re.sub(r"\d+", "", re.sub(r"[._-]+", " ", fold_accents(local))).strip().lower()
            if len(cleaned) >= 4:
                cibc_names.add(cleaned)
                parts = cleaned.split()
                if len(parts) >= 2:
                    cibc_names.add(f"{parts[0]} {parts[-1]}")

    has_cibc_branding = bool(re.search(r"\bCIBC\b", text, re.IGNORECASE))
    for zs in ZONE_START_RE.finditer(text):
        heading = zs.group(0)
        if "cibc" not in heading.lower() and not has_cibc_branding:
            continue
        start = zs.start()
        ze = ZONE_END_RE.search(text, pos=start + len(heading))
        end = min(ze.start(), start + 450) if ze else min(len(text), start + 350)
        cibc_zones.append((start, end))

    return cibc_names, cibc_zones


def in_zones(start: int, end: int, zones: Sequence[Tuple[int, int]]) -> bool:
    return any(start >= zs and end <= ze for zs, ze in zones)


def normalize_person_key(name: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z\s-]", " ", fold_accents(name)).replace("-", " ")
    return " ".join(cleaned.lower().split())


def detect_pii_regex(
    text: str,
    enabled_entities: Sequence[str],
    ignore_cibc_employees: bool = True,
    extra_cibc_names: Optional[Set[str]] = None,
) -> List[PiiMatch]:
    enabled = set(enabled_entities)
    cibc_names, cibc_zones = extract_cibc_context(text) if ignore_cibc_employees else (set(), [])
    if extra_cibc_names:
        cibc_names = cibc_names | extra_cibc_names
    matches: List[PiiMatch] = []

    if "EMAIL" in enabled:
        for m in EMAIL_RE.finditer(text):
            val = m.group(0)
            if ignore_cibc_employees and CIBC_EMAIL_DOMAIN_RE.search(val):
                continue
            matches.append(PiiMatch("EMAIL", val, m.start(), m.end(), 0.99))

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
            if ignore_cibc_employees and in_zones(m.start(), m.end(), cibc_zones):
                continue
            matches.append(PiiMatch("CANADIAN_BANK_ACCOUNT", m.group(0), m.start(), m.end(), 0.95))
        for m in BANK_LABELED_ACCOUNT_RE.finditer(text):
            if ignore_cibc_employees and in_zones(m.start(1), m.end(1), cibc_zones):
                continue
            val = m.group(1)
            if sum(1 for c in val if c.isdigit()) < 3:
                continue
            matches.append(PiiMatch("CANADIAN_BANK_ACCOUNT", val, m.start(1), m.end(1), 0.93))

    if "LEGAL_CASE_ID" in enabled:
        for m in CRA_BN_RE.finditer(text):
            matches.append(PiiMatch("LEGAL_CASE_ID", m.group(0), m.start(), m.end(), 0.96))
        for m in LEGAL_CASE_RE.finditer(text):
            matches.append(PiiMatch("LEGAL_CASE_ID", m.group(1), m.start(1), m.end(1), 0.92))

    if "PHONE" in enabled:
        for m in PHONE_FORMATTED_RE.finditer(text):
            if ignore_cibc_employees and in_zones(m.start(), m.end(), cibc_zones):
                continue
            val = m.group(0).strip()
            if len(re.sub(r"\D", "", val)) >= 10:
                matches.append(PiiMatch("PHONE", val, m.start(), m.end(), 0.92))
        for m in PHONE_COMPACT_RE.finditer(text):
            if ignore_cibc_employees and in_zones(m.start(), m.end(), cibc_zones):
                continue
            val = m.group(0).strip()
            matches.append(PiiMatch("PHONE", val, m.start(), m.end(), 0.76))

    if "DOB" in enabled:
        for m in DOB_RE.finditer(text):
            matches.append(PiiMatch("DOB", m.group(1), m.start(1), m.end(1), 0.94))

    if "ADDRESS" in enabled:
        for m in ADDRESS_FULL_CA_RE.finditer(text):
            if ignore_cibc_employees and in_zones(m.start(), m.end(), cibc_zones):
                continue
            matches.append(PiiMatch("ADDRESS", m.group(0), m.start(), m.end(), 0.94))
        for m in ADDRESS_STREET_RE.finditer(text):
            if ignore_cibc_employees and in_zones(m.start(), m.end(), cibc_zones):
                continue
            matches.append(PiiMatch("ADDRESS", m.group(0), m.start(), m.end(), 0.88))
        for m in ADDRESS_FR_LINE_RE.finditer(text):
            if ignore_cibc_employees and in_zones(m.start(), m.end(), cibc_zones):
                continue
            matches.append(PiiMatch("ADDRESS", m.group(0), m.start(), m.end(), 0.88))
        for m in POSTAL_CODE_ONLY_RE.finditer(text):
            if ignore_cibc_employees and in_zones(m.start(), m.end(), cibc_zones):
                continue
            matches.append(PiiMatch("ADDRESS", m.group(0), m.start(), m.end(), 0.91))

    if "PASSPORT" in enabled:
        for m in PASSPORT_RE.finditer(text):
            matches.append(PiiMatch("PASSPORT", m.group(1), m.start(1), m.end(1), 0.90))

    if "PERSON" in enabled:
        for m in PERSON_CONTEXT_RE.finditer(text):
            candidate = m.group(1).strip()
            if len(candidate) < 5 or candidate in COMMON_NON_PERSON_BIGRAMS:
                continue
            lower_parts = [
                re.sub(r"[^a-zA-Z-]", "", fold_accents(p)).lower()
                for p in candidate.split()
            ]
            lower_parts = [p for p in lower_parts if p]
            if len(lower_parts) < 2 or any(w in COMMON_NON_PERSON_WORDS for w in lower_parts):
                continue
            if ignore_cibc_employees:
                if in_zones(m.start(1), m.end(1), cibc_zones):
                    continue
                if normalize_person_key(candidate) in cibc_names:
                    continue
            matches.append(PiiMatch("PERSON", candidate, m.start(1), m.end(1), 0.91))

        for m in PERSON_STANDALONE_RE.finditer(text):
            candidate = m.group(1).strip()
            if candidate in COMMON_NON_PERSON_BIGRAMS or len(candidate) < 6:
                continue
            lower_parts = [
                re.sub(r"[^a-zA-Z-]", "", fold_accents(p)).lower()
                for p in candidate.split()
            ]
            lower_parts = [p for p in lower_parts if p]
            if len(lower_parts) < 2:
                continue
            if any(w in COMMON_NON_PERSON_WORDS for w in lower_parts):
                continue
            if any(seg in COMMON_NON_PERSON_WORDS for w in lower_parts for seg in w.split("-")):
                continue
            if ignore_cibc_employees:
                if in_zones(m.start(1), m.end(1), cibc_zones):
                    continue
                if normalize_person_key(candidate) in cibc_names:
                    continue
            first_word = lower_parts[0]
            first_base = first_word.split("-")[0]
            conf = 0.90 if (first_word in COMMON_FIRST_NAMES or first_base in COMMON_FIRST_NAMES) else 0.78
            matches.append(PiiMatch("PERSON", candidate, m.start(1), m.end(1), conf))

    matches.sort(key=lambda item: (item.start, -(item.end - item.start), -item.confidence))
    deduped: List[PiiMatch] = []
    last_end = -1
    for item in matches:
        if item.start >= last_end:
            deduped.append(item)
            last_end = item.end
    return deduped


def detect_pii_presidio(
    text: str,
    enabled_entities: Sequence[str],
    ignore_cibc_employees: bool = True,
    extra_cibc_names: Optional[Set[str]] = None,
) -> List[PiiMatch]:
    """Optional Microsoft Presidio + spaCy NER engine merged with Canadian patterns."""
    matches = detect_pii_regex(
        text,
        enabled_entities,
        ignore_cibc_employees=ignore_cibc_employees,
        extra_cibc_names=extra_cibc_names,
    )
    cibc_names, cibc_zones = extract_cibc_context(text) if ignore_cibc_employees else (set(), [])
    if extra_cibc_names:
        cibc_names = cibc_names | extra_cibc_names

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
            if ignore_cibc_employees:
                if etype == "EMAIL" and CIBC_EMAIL_DOMAIN_RE.search(snippet):
                    continue
                if in_zones(res.start, res.end, cibc_zones):
                    continue
                if etype == "PERSON" and normalize_person_key(snippet) in cibc_names:
                    continue
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


FR_MONTH_NAMES = [
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
]
EN_MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


def format_mock_dob(fake: Faker, original: str) -> str:
    dt = fake.date_of_birth(minimum_age=21, maximum_age=78)
    if re.match(r"^\d{4}/\d{2}/\d{2}$", original):
        return dt.strftime("%Y/%m/%d")
    if re.match(r"^\d{4}-\d{2}-\d{2}$", original):
        return dt.strftime("%Y-%m-%d")
    if re.match(r"^\d{2}/\d{2}/\d{4}$", original):
        return dt.strftime("%m/%d/%Y")
    if re.match(r"^\d{2}-\d{2}-\d{4}$", original):
        return dt.strftime("%m-%d-%Y")
    if re.match(rf"^\d{{1,2}}\s+{FR_MONTHS_RE}\s+\d{{4}}$", original, re.IGNORECASE):
        return f"{dt.day} {FR_MONTH_NAMES[dt.month - 1]} {dt.year}"
    if re.match(r"^[A-Za-z]+\s+\d{1,2},?\s+\d{4}$", original):
        mon = EN_MONTH_NAMES[dt.month - 1]
        return f"{mon} {dt.day}, {dt.year}" if "," in original else f"{mon[:3]} {dt.day} {dt.year}"
    return dt.strftime("%Y-%m-%d")


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
        name = fake.name()
        letters = re.sub(r"[^a-zA-ZÀ-ÿ]", "", original_value)
        return name.upper() if letters and letters == letters.upper() else name
    if entity_type == "EMAIL":
        first = re.sub(r"[^a-z]", "", fake.first_name().lower()) or "alex"
        last = re.sub(r"[^a-z]", "", fake.last_name().lower()) or "tremblay"
        return f"{first}.{last}@example.ca"
    if entity_type == "PHONE":
        area = fake.random_element(["416", "647", "604", "778", "403", "587", "514", "418", "819", "613", "902"])
        exch = fake.random_int(min=200, max=999)
        line = fake.random_int(min=1000, max=9999)
        if original_value.startswith("+1"):
            return f"+1-{area}-{exch}-{line}"
        if "." in original_value:
            return f"{area}.{exch}.{line}"
        if "-" in original_value and "(" not in original_value:
            return f"{area}-{exch}-{line}"
        if re.match(r"^\d{10}$", original_value):
            return f"{area}{exch}{line}"
        return f"({area}) {exch}-{line}"
    if entity_type == "SIN":
        return make_luhn_sin(fake, original_value)
    if entity_type == "CREDIT_CARD":
        return make_luhn_card(fake, original_value)
    if entity_type == "CANADIAN_BANK_ACCOUNT":
        if re.match(r"^\d{5}[-\s]\d{3}[-\s]\d{7,12}$", original_value):
            transit = fake.numerify("#####")
            inst = fake.random_element(["001", "002", "003", "004", "006", "010"])
            acct_len = len(re.split(r"[-\s]", original_value)[2])
            acct = fake.numerify("#" * acct_len)
            sep = " " if " " in original_value else "-"
            return f"{transit}{sep}{inst}{sep}{acct}"
        return preserve_format_mock(fake, original_value, keep_known_prefix=True)
    if entity_type == "LEGAL_CASE_ID":
        bn_match = re.match(r"^(\d{9})([ \t]?)(RP|RC|RT|RR|RQ)([ \t]?)(\d{4})$", original_value, re.IGNORECASE)
        if bn_match:
            return f"{fake.numerify('#########')}{bn_match.group(2)}{bn_match.group(3).upper()}{bn_match.group(4)}{bn_match.group(5)}"
        return preserve_format_mock(fake, original_value, keep_known_prefix=True)
    if entity_type == "DOB":
        return format_mock_dob(fake, original_value)
    if entity_type == "ADDRESS":
        if re.match(rf"^{CA_POSTAL_RE_STR}$", original_value.strip()):
            return fake.postalcode()
        if "," in original_value:
            return f"{fake.street_address()}, {fake.city()}, {fake.province_abbr()} {fake.postalcode()}"
        return fake.street_address()
    if entity_type == "PASSPORT":
        return preserve_format_mock(fake, original_value, keep_known_prefix=False)
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
        # Bake AcroForm widgets into page contents when supported so widgets cannot overlay redactions
        try:
            if hasattr(doc, "bake"):
                doc.bake()
        except Exception:
            pass

        page_count = len(doc)
        mode: str = cfg["mode"]
        consistent: bool = cfg["consistent"]
        seed: int = cfg["seed"]
        min_confidence: float = cfg["min_confidence"]
        enabled_entities: List[str] = cfg["entities"]
        engine: str = cfg["engine"]
        include_mapping: bool = cfg["include_mapping"]
        ignore_cibc_employees: bool = cfg.get("ignore_cibc_employees", True)

        # Collect CIBC employee email-derived names across the entire document first
        doc_cibc_names: Set[str] = set()
        if ignore_cibc_employees:
            for p in doc:
                c_names, _ = extract_cibc_context(p.get_text("text"))
                doc_cibc_names.update(c_names)

        for page_index, page in enumerate(doc):
            page_text = page.get_text("text")
            if not page_text.strip():
                continue

            if engine == "presidio":
                raw_matches = detect_pii_presidio(
                    page_text,
                    enabled_entities,
                    ignore_cibc_employees=ignore_cibc_employees,
                    extra_cibc_names=doc_cibc_names,
                )
            else:
                raw_matches = detect_pii_regex(
                    page_text,
                    enabled_entities,
                    ignore_cibc_employees=ignore_cibc_employees,
                    extra_cibc_names=doc_cibc_names,
                )

            matches, skipped_page = filter_by_confidence(raw_matches, min_confidence)
            total_skipped += skipped_page

            if not matches:
                continue

            pending_replacements: List[Tuple[fitz.Rect, str, float]] = []
            seen_rects: List[fitz.Rect] = []
            redacted_strings_page: List[str] = []

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
                redacted_strings_page.append(match.text.lower())
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
                    padded = fitz.Rect(rect.x0 - 1, rect.y0 - 1.5, rect.x1 + 1.5, rect.y1 + 1.5)
                    seen_rects.append(padded)
                    font_size = estimate_font_size(page, rect)
                    fill_color = (0.06, 0.09, 0.16) if mode == "solid_mask" else (0.96, 0.97, 0.99)
                    if mode == "whiteout_replace":
                        fill_color = (1.0, 1.0, 1.0)
                    page.add_redact_annot(padded, text="", fill=fill_color)
                    pending_replacements.append((padded, replacement, font_size))
                    total_masked += 1

            # Delete clickable mailto:/URI links overlapping redacted areas or containing redacted PII
            try:
                for link in list(page.get_links()):
                    uri = str(link.get("uri", "")).lower()
                    lrect = link.get("from")
                    uri_hit = uri and any(s in uri for s in redacted_strings_page if len(s) >= 3)
                    rect_hit = lrect is not None and any(lrect.intersects(r) for r in seen_rects)
                    if uri_hit or rect_hit:
                        page.delete_link(link)
            except Exception:
                pass

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
        description="Canadian Banking & Legal Batch PDF PII anonymizer (English & French, 1 to 1,000+ PDFs)."
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
    parser.add_argument(
        "--ignore-cibc-employees",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Ignore CIBC employee names, @cibc.com/@cibc.ca emails, and Branch Contact sections (default: True).",
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
        "ignore_cibc_employees": bool(args.ignore_cibc_employees),
    }

    tasks: List[Tuple[str, str, str, dict]] = []
    for src in pdf_files:
        rel = src.relative_to(input_dir)
        dst = output_dir / rel
        tasks.append((str(src), str(dst), str(rel), cfg))

    print(
        f"Processing {len(tasks)} Canadian PDF(s) with {args.workers} worker(s) "
        f"[min_confidence > {args.min_confidence:.2f}, ignore_cibc={cfg['ignore_cibc_employees']}] -> {output_dir}"
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
        "ignore_cibc_employees": bool(args.ignore_cibc_employees),
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
