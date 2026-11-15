# RedactBatch — Canadian Banking & Legal PDF PII Anonymizer

RedactBatch is a batch PDF anonymization system built for Canadian financial, wealth management, payroll, tax, and family-law documents (bank statements, LIRA/RRSP/TFSA forms, payslips, CRA Notices of Assessment, and divorce decrees). It includes:

1. **Interactive Web Workspace** (`server.ts` + React): Stage 1 to 1,000 PDFs, tune detection rules and confidence thresholds, process batches, inspect before/after PDF pages side-by-side, and export anonymized ZIP archives.
2. **Standalone Python Batch CLI** (`python/anonymize_pdfs.py`): High-throughput multi-core CLI using `PyMuPDF` (`fitz`) redaction annotations and `Faker("en_CA")` for irreversible stream-level masking and type-appropriate Canadian mock replacement across 1 to 1,000+ PDFs.

---

## How the System Works

1. **Folder Ingestion (1 to 1,000+ PDFs)**
   - Scans the input directory (with optional `--recursive` folder traversal) while preserving relative subdirectory paths (`statements/`, `lira/`, `payslips/`, `legal/`, `tax/`).
2. **PDF Text & Coordinate Extraction**
   - **Web / Node engine**: Uses `pdfjs-dist` to extract text lines and compute exact `(x, y, width, height, fontSize)` bounding boxes per page.
   - **Python CLI**: Uses `PyMuPDF` (`fitz`) to extract page text, locate exact match rectangles via `page.search_for(...)`, and estimate span font sizes.
3. **Canadian PII Identification & Confidence Scoring**
   - Detects entities and assigns a confidence score (`0.00`–`1.00`) per match:
     - `EMAIL` (`0.99`)
     - `SIN` (`0.98` labeled + Luhn-valid, `0.96` dashed, `0.88` spaced; validated with Mod-10 Luhn and Canadian first-digit rules)
     - `CREDIT_CARD` (`0.98` Luhn-validated 13–19 digit cards)
     - `LEGAL_CASE_ID` (`0.96` CRA Business/Payroll Numbers `######### RP 0001`, `0.92` Divorce Court File / Docket numbers `FS-24-...`)
     - `CANADIAN_BANK_ACCOUNT` (`0.95` 5-digit Transit + 3-digit Institution + Account tuples, `0.93` labeled LIRA/RRSP/TFSA/Chequing/Mortgage accounts)
     - `ADDRESS` (`0.94` full Canadian Province + Postal Code `A1A 1A1`, `0.91` standalone Postal Code, `0.88` street line; supports English & French street prefixes)
     - `DOB` (`0.94` labeled birth, marriage, and separation dates)
     - `PHONE` (`0.92` formatted `(416) 892-3410`, `0.76` compact 10-digit)
     - `PERSON` (`0.90` context roles: `Account Holder`, `Applicant`, `Petitioner`, `Respondent`, `Spouse`, `Beneficiary`, `Payor`, `Payee`, `Employee`, `Taxpayer`; `0.78` standalone unprefixed names)
     - `PASSPORT` (`0.90` Canadian Passports & Provincial Driver's Licences)
4. **Confidence Threshold Filtering (`--min-confidence`)**
   - Default threshold is **`0.85`**. Only detections whose confidence score strictly exceeds the threshold (`confidence > min_confidence`) are masked. Lowering toward `0.72`–`0.78` enables aggressive recall for unprefixed names and compact numbers; raising toward `0.94` restricts masking to deterministic formats.
5. **Irreversible Masking & Type-Appropriate Mock Replacement**
   - **Python CLI**: Queues `page.add_redact_annot(...)`, calls `page.apply_redactions()` to permanently delete original PII bytes from the PDF content stream, and writes `Faker("en_CA")` mock replacements inside the vacated bounding box.
   - **Web / Node engine**: Scrubs matched ASCII and hex-encoded PDF stream literals (`scrubStreamStrings`), draws the opaque mask/replacement with `pdf-lib`, and re-extracts text with `pdfjs-dist` to verify `streamVerifiedClean`.
   - **Consistent Pseudonymization (`--consistent` + `--seed`)**: Hashes `(seed, entity_type, normalized_value)` with SHA-256 to seed `Faker`, ensuring identical PII maps to the exact same mock value across all pages and all 1,000+ PDFs without cross-process lock contention.
6. **Output Directory & Audit Manifest**
   - Writes anonymized PDFs to the designated output directory mirroring the input folder tree, alongside `anonymization_manifest.json` summarizing entity counts, skipped below-threshold detections, timings, and verification status.

---

## Project Structure

```text
├── python/
│   ├── anonymize_pdfs.py      # Standalone multi-process Python CLI (1 to 1,000+ PDFs)
│   ├── requirements.txt       # Python dependencies (PyMuPDF, Faker, tqdm)
│   └── README.md              # Python CLI usage & entity reference
├── server/
│   ├── piiEngine.ts           # Canadian PII detectors, Luhn validators & en_CA mock generator
│   └── pdfProcessor.ts        # PDF coordinate extraction, stream scrubbing, masking & sample generator
├── src/
│   ├── components/            # Batch workspace, side-by-side PDF canvas diff, Python CLI, Audit views
│   ├── App.tsx                # Application shell & state orchestration
│   └── types.ts               # Shared TypeScript interfaces
├── server.ts                  # Express API + Vite dev/static server (port 3000)
└── README.md
```

---

## How to Run

### Option A: Web Workspace (Node.js + React)

**Prerequisites:** Node.js `>= 20` (tested on Node `v22`)

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the development server (runs Express + Vite on port `3000`):
   ```bash
   npm run dev
   ```
   Or build and run in production mode:
   ```bash
   npm run build
   NODE_ENV=production npm start
   ```
3. Open `http://localhost:3000` in your browser.

### Option B: Python Batch CLI (Recommended for 1,000+ Local PDFs)

**Prerequisites:** Python `>= 3.10`

1. Create a virtual environment and install dependencies:
   ```bash
   cd python
   python3 -m venv .venv
   source .venv/bin/activate   # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```
2. Place your raw PDFs in an input folder (for example `./raw_canadian_pdfs`).
3. Run the batch anonymizer:
   ```bash
   python3 anonymize_pdfs.py \
     --input-dir ./raw_canadian_pdfs \
     --output-dir ./anonymized_pdfs \
     --recursive \
     --mode mask_and_replace \
     --min-confidence 0.85 \
     --consistent \
     --seed 42 \
     --workers 8
   ```

---

## Step-by-Step Usage Guide

### Using the Web Workspace
1. **Stage Input PDFs**: Click **Select Folder** (supports nested folders up to 1,000 PDFs), **Add PDFs**, or **Load 5 / 25 Sample PDFs** to generate synthetic Canadian documents (RBC Chequing Statement, TD LIRA Transfer, Payslip, Ontario Divorce Decree, CRA Notice of Assessment).
2. **Set Output Directory Label & Masking Mode**: Choose `Mask + Mock PII` (bordered mask + synthetic replacement), `Seamless Replace` (whiteout + replacement), or `Solid Redaction Bar` (`[REDACTED:TYPE]`).
3. **Tune Confidence Threshold & Detectors**: Keep the default `0.85` threshold or slide lower/higher, toggle any of the 10 Canadian PII detectors, and optionally add custom regex rules (e.g., internal client IDs).
4. **Run & Inspect**: Click **Anonymize PDFs**, click **Inspect** on any row to visually compare the original input PDF against the anonymized output PDF page-by-page, review the **Audit Manifest** tab, and click **Download Output ZIP** to save all anonymized files.
5. **Export Tailored Python CLI**: Open the **Python CLI Tool** tab and click **Download Python Bundle (.zip)** to get `anonymize_pdfs.py` plus a pre-configured `run_batch.sh` matching your UI settings.

### Python CLI Flags Reference
- `--input-dir` *(required)*: Source folder containing 1 to 1,000+ PDFs.
- `--output-dir` *(required)*: Designated output directory for anonymized PDFs.
- `--recursive`: Traverse subdirectories and preserve folder hierarchy.
- `--mode`: `mask_and_replace` (default), `whiteout_replace`, or `solid_mask`.
- `--min-confidence`: Confidence cutoff in `[0.0, 1.0]` (default `0.85`).
- `--entities`: Comma-separated list of entity types to mask.
- `--consistent`: Deterministically map identical PII to the same mock value across all PDFs.
- `--seed`: Integer seed for reproducible mock data (default `42`).
- `--workers`: Parallel worker processes for multi-core batches.
- `--engine`: `regex` (default, zero external model downloads) or `presidio` (combines Microsoft Presidio/spaCy NER if installed).
- `--include-mapping`: Include `original -> replacement` mapping inside `anonymization_manifest.json` (disabled by default for security).
