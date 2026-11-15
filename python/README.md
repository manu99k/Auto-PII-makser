# Canadian Banking & Legal Batch PDF PII Anonymizer (Python CLI)

Built for Canadian financial institutions, wealth management (LIRA / RRSP / TFSA), payroll (payslips), tax (CRA Notices of Assessment), and family law documents (divorce decrees, separation agreements). Processes 1 to 1,000+ PDFs in an input directory, masks only detections whose confidence strictly exceeds `--min-confidence` (default `0.85`), irreversibly scrubs original text via `PyMuPDF` redactions, and inserts Canadian `Faker("en_CA")` mock PII at exact coordinates.

## Installation

```bash
pip install -r requirements.txt
```

## Quick Start

```bash
python anonymize_pdfs.py \
  --input-dir ./canadian_docs \
  --output-dir ./anonymized_docs \
  --recursive \
  --min-confidence 0.85 \
  --consistent \
  --seed 42 \
  --workers 8
```

## Confidence Threshold (`--min-confidence`)

- **Default**: `0.85` (only masks PII detections with confidence `> 0.85`).
- **How to adjust**:
  - **Strict precision (`0.94`)**: Masks deterministic formats only — Email (`0.99`), Luhn-valid Credit Cards (`0.98`), Labeled/Luhn-valid SINs (`0.96`–`0.98`), CRA Business Numbers (`0.96`), Transit-Institution-Account tuples (`0.95`), full Canadian Province + Postal Code addresses (`0.94`), and labeled DOB/Marriage dates (`0.94`).
  - **Balanced default (`0.85`)**: Also masks context-labeled Person Names including `Petitioner`, `Respondent`, `Spouse`, `Beneficiary`, `Payor`, `Payee`, `Employee` (`0.90`), LIRA/RRSP/TFSA/Mortgage account numbers (`0.93`), Court File / Divorce Docket numbers (`0.92`), formatted Canadian Phone Numbers (`0.92`), Postal Codes (`0.91`), and Canadian Passports/Driver's Licences (`0.90`).
  - **High recall (`0.72`)**: Also masks unprefixed standalone Person Names (`0.78`) and compact 10-digit phone numbers (`0.76`).

## Canadian PII Entities & Mock Data

| Entity Type | Canadian Document Scope | Mock Replacement (`en_CA`) |
| :--- | :--- | :--- |
| `PERSON` | Account holders, employees, petitioners, respondents, beneficiaries (`0.90` / `0.78`) | Canadian `Faker("en_CA")` full name |
| `SIN` | Canadian Social Insurance Number `XXX-XXX-XXX` (Mod-10 Luhn validated, `0.96`–`0.98`) | Luhn-valid synthetic `9xx-xxx-xxx` SIN |
| `CANADIAN_BANK_ACCOUNT` | Transit-Institution-Account (`00412-003-...`), LIRA/RRSP/TFSA/Mortgage accounts (`0.93`–`0.95`) | Format-matched Transit/Inst/Account or `LIRA-########` |
| `ADDRESS` | Street + Province (`ON/QC/BC/AB/...`) + Postal Code `A1A 1A1` (`0.88`–`0.94`) | Canadian address & valid `A1A 1A1` postal code |
| `PHONE` | Canadian area codes `(416)`, `(647)`, `(604)`, `(403)`, `(514)` (`0.92` / `0.76`) | Format-preserving Canadian phone number |
| `EMAIL` | Email addresses (`0.99`) | `first.last@example.ca` |
| `CREDIT_CARD` | Luhn-validated 13–19 digit cards (`0.98`) | Luhn-valid synthetic 16-digit card |
| `DOB` | Birth, marriage, and separation dates (`0.94`) | `YYYY-MM-DD` Canadian ISO date |
| `LEGAL_CASE_ID` | Divorce Court File / Docket numbers (`FS-24-...`), CRA Payroll/BN (`... RP 0001`) (`0.92`–`0.96`) | Synthetic `FS-##-#######-0000` / CRA BN |
| `PASSPORT` | Canadian Passport / Provincial Driver's Licence (`0.90`) | Synthetic alphanumeric ID `??######` |
