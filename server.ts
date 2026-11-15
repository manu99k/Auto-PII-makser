import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import JSZip from 'jszip';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import {
  anonymizePdfBuffer,
  generateSamplePdfBatch,
} from './server/pdfProcessor.ts';
import type {
  BatchConfig,
  BatchJobResult,
  ProcessedFileResult,
  UploadedFileSummary,
} from './src/types.ts';

const WORKSPACE_ROOT = path.join(os.tmpdir(), 'redactbatch-workspace');

function isPathInside(baseDir: string, targetPath: string): boolean {
  const rel = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function safeWorkspaceId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
}

function safeRelativePath(raw: string): string {
  const normalized = path.posix
    .normalize(raw.replace(/\\/g, '/'))
    .replace(/^(\.\.(\/|\\|$))+/, '')
    .replace(/^\/+/, '');
  return normalized || 'document.pdf';
}

async function ensureWorkspaceDirs(workspaceId: string) {
  const base = path.join(WORKSPACE_ROOT, safeWorkspaceId(workspaceId));
  const inputDir = path.join(base, 'input');
  const outputDir = path.join(base, 'output');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  return { base, inputDir, outputDir };
}

async function walkPdfFiles(dir: string, rootDir: string): Promise<UploadedFileSummary[]> {
  const results: UploadedFileSummary[] = [];
  let entries: Array<import('node:fs').Dirent> = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkPdfFiles(full, rootDir);
      results.push(...nested);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
      const stat = await fs.stat(full);
      const rel = path.relative(rootDir, full).split(path.sep).join('/');
      results.push({
        filename: entry.name,
        relativePath: rel,
        sizeBytes: stat.size,
      });
    }
  }
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1000,
    fileSize: 250 * 1024 * 1024, // 250MB per PDF
    fieldSize: 50 * 1024 * 1024, // Support large relativePaths metadata JSON
  },
});

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Generate realistic synthetic PII PDFs into the workspace input directory
  app.post('/api/workspace/samples', async (req, res) => {
    try {
      const workspaceId = safeWorkspaceId(
        typeof req.body?.workspaceId === 'string' && req.body.workspaceId
          ? req.body.workspaceId
          : crypto.randomUUID().slice(0, 12)
      );
      const count = Number(req.body?.count) || 5;
      const replaceExisting = req.body?.replaceExisting !== false;

      const { inputDir, outputDir } = await ensureWorkspaceDirs(workspaceId);
      if (replaceExisting) {
        await fs.rm(inputDir, { recursive: true, force: true });
        await fs.rm(outputDir, { recursive: true, force: true });
        await fs.mkdir(inputDir, { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
      }

      const samples = await generateSamplePdfBatch(count);
      for (const sample of samples) {
        const dest = path.join(inputDir, safeRelativePath(sample.relativePath));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, sample.bytes);
      }

      const files = await walkPdfFiles(inputDir, inputDir);
      res.json({ workspaceId, files });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to generate sample PDFs',
      });
    }
  });

  // Upload 1 to 1,000 PDFs or an entire folder
  app.post('/api/workspace/upload', (req, res, next) => {
    upload.array('files', 1000)(req, res, (err) => {
      if (err) {
        const message =
          err instanceof multer.MulterError
            ? `Upload limit error (${err.code}): ${err.message}`
            : err instanceof Error
            ? err.message
            : 'Upload middleware failed';
        return res.status(400).json({ error: message });
      }
      next();
    });
  }, async (req, res) => {
    try {
      const rawId =
        typeof req.body?.workspaceId === 'string' && req.body.workspaceId
          ? req.body.workspaceId
          : crypto.randomUUID().slice(0, 12);
      const workspaceId = safeWorkspaceId(rawId);
      const replaceExisting = req.body?.replaceExisting === 'true';

      const { inputDir, outputDir } = await ensureWorkspaceDirs(workspaceId);
      if (replaceExisting) {
        await fs.rm(inputDir, { recursive: true, force: true });
        await fs.rm(outputDir, { recursive: true, force: true });
        await fs.mkdir(inputDir, { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
      }

      const uploadedFiles = (req.files as Express.Multer.File[]) ?? [];
      let relativePaths: string[] = [];
      if (typeof req.body?.relativePaths === 'string') {
        try {
          const parsed = JSON.parse(req.body.relativePaths);
          if (Array.isArray(parsed)) relativePaths = parsed;
        } catch {
          relativePaths = [];
        }
      }

      let savedCount = 0;
      for (let i = 0; i < uploadedFiles.length; i++) {
        const file = uploadedFiles[i];
        if (!file.originalname.toLowerCase().endsWith('.pdf')) continue;
        const rawRel = relativePaths[i] || file.originalname;
        const rel = safeRelativePath(rawRel);
        const dest = path.join(inputDir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, file.buffer);
        savedCount++;
      }

      const files = await walkPdfFiles(inputDir, inputDir);
      res.json({ workspaceId, savedCount, files });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Upload failed',
      });
    }
  });

  app.delete('/api/workspace/:workspaceId/files', async (req, res) => {
    try {
      const workspaceId = safeWorkspaceId(req.params.workspaceId);
      const { inputDir, outputDir } = await ensureWorkspaceDirs(workspaceId);
      await fs.rm(inputDir, { recursive: true, force: true });
      await fs.rm(outputDir, { recursive: true, force: true });
      await fs.mkdir(inputDir, { recursive: true });
      await fs.mkdir(outputDir, { recursive: true });
      res.json({ ok: true, files: [] });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to clear workspace',
      });
    }
  });

  // Process all PDFs in workspace input directory and save anonymized files to output directory
  app.post('/api/workspace/:workspaceId/process', async (req, res) => {
    try {
      const workspaceId = safeWorkspaceId(req.params.workspaceId);
      const { inputDir, outputDir } = await ensureWorkspaceDirs(workspaceId);
      const config = req.body?.config as BatchConfig | undefined;
      const inputFolderLabel =
        typeof req.body?.inputFolderLabel === 'string' && req.body.inputFolderLabel.trim()
          ? req.body.inputFolderLabel.trim()
          : './input_pdfs';
      const outputFolderLabel =
        typeof req.body?.outputFolderLabel === 'string' && req.body.outputFolderLabel.trim()
          ? req.body.outputFolderLabel.trim()
          : './anonymized_pdfs';

      if (!config) {
        return res.status(400).json({ error: 'Missing batch configuration' });
      }

      const inputFiles = await walkPdfFiles(inputDir, inputDir);
      if (inputFiles.length === 0) {
        return res.status(400).json({ error: 'No PDF files staged in the input batch.' });
      }

      // Clean output folder before fresh batch run
      await fs.rm(outputDir, { recursive: true, force: true });
      await fs.mkdir(outputDir, { recursive: true });

      const tStart = performance.now();
      const reports: ProcessedFileResult[] = [];

      // Process in bounded concurrent chunks of 4 for fast throughput without memory spikes
      const CONCURRENCY = 4;
      for (let i = 0; i < inputFiles.length; i += CONCURRENCY) {
        const chunk = inputFiles.slice(i, i + CONCURRENCY);
        const chunkResults = await Promise.all(
          chunk.map(async (f) => {
            const srcPath = path.join(inputDir, safeRelativePath(f.relativePath));
            const dstPath = path.join(outputDir, safeRelativePath(f.relativePath));
            const buf = await fs.readFile(srcPath);
            const { outputBuffer, report } = await anonymizePdfBuffer(
              new Uint8Array(buf),
              f.filename,
              f.relativePath,
              config
            );
            await fs.mkdir(path.dirname(dstPath), { recursive: true });
            await fs.writeFile(dstPath, outputBuffer);
            return report;
          })
        );
        reports.push(...chunkResults);
      }

      const elapsedMs = Math.round(performance.now() - tStart);
      const succeeded = reports.filter((r) => r.status === 'completed').length;
      const failed = reports.length - succeeded;
      const totalPiiMasked = reports.reduce((acc, r) => acc + r.entitiesMasked, 0);

      const jobResult: BatchJobResult = {
        jobId: workspaceId,
        createdAt: new Date().toISOString(),
        inputFolderLabel,
        outputFolderLabel,
        config,
        totalFiles: reports.length,
        succeeded,
        failed,
        totalPiiMasked,
        elapsedMs,
        files: reports,
      };

      await fs.writeFile(
        path.join(outputDir, 'anonymization_manifest.json'),
        JSON.stringify(jobResult, null, 2),
        'utf-8'
      );

      res.json(jobResult);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Batch anonymization failed',
      });
    }
  });

  // Serve raw PDF bytes for visual side-by-side inspection
  app.get('/api/workspace/:workspaceId/pdf', async (req, res) => {
    try {
      const workspaceId = safeWorkspaceId(req.params.workspaceId);
      const side = req.query.side === 'output' ? 'output' : 'input';
      const rel = safeRelativePath(String(req.query.path || ''));
      const { inputDir, outputDir } = await ensureWorkspaceDirs(workspaceId);
      const baseDir = side === 'output' ? outputDir : inputDir;
      const target = path.resolve(baseDir, rel);

      if (!isPathInside(baseDir, target)) {
        return res.status(403).json({ error: 'Invalid path' });
      }

      const bytes = await fs.readFile(target);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'no-store');
      res.send(bytes);
    } catch {
      res.status(404).json({ error: 'PDF file not found' });
    }
  });

  // Download a single anonymized PDF
  app.get('/api/workspace/:workspaceId/download-file', async (req, res) => {
    try {
      const workspaceId = safeWorkspaceId(req.params.workspaceId);
      const rel = safeRelativePath(String(req.query.path || ''));
      const { outputDir } = await ensureWorkspaceDirs(workspaceId);
      const target = path.resolve(outputDir, rel);

      if (!isPathInside(outputDir, target)) {
        return res.status(403).json({ error: 'Invalid path' });
      }

      const bytes = await fs.readFile(target);
      const filename = path.basename(target);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(bytes);
    } catch {
      res.status(404).json({ error: 'Anonymized file not found' });
    }
  });

  // Download entire designated output directory as a ZIP archive
  app.get('/api/workspace/:workspaceId/download-zip', async (req, res) => {
    try {
      const workspaceId = safeWorkspaceId(req.params.workspaceId);
      const { outputDir } = await ensureWorkspaceDirs(workspaceId);
      const files = await walkPdfFiles(outputDir, outputDir);

      if (files.length === 0) {
        return res.status(404).json({ error: 'No anonymized files ready for download.' });
      }

      const zip = new JSZip();
      for (const f of files) {
        const bytes = await fs.readFile(path.join(outputDir, safeRelativePath(f.relativePath)));
        zip.file(f.relativePath, bytes);
      }

      const manifestPath = path.join(outputDir, 'anonymization_manifest.json');
      try {
        const manifest = await fs.readFile(manifestPath, 'utf-8');
        zip.file('anonymization_manifest.json', manifest);
      } catch {
        // Optional manifest
      }

      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="anonymized_pdfs_${workspaceId}.zip"`
      );
      res.send(zipBuffer);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to build ZIP archive',
      });
    }
  });

  // Expose Python CLI tool source files
  app.get('/api/python/files', async (_req, res) => {
    try {
      const pyDir = path.resolve(process.cwd(), 'python');
      const [script, requirements, readme] = await Promise.all([
        fs.readFile(path.join(pyDir, 'anonymize_pdfs.py'), 'utf-8'),
        fs.readFile(path.join(pyDir, 'requirements.txt'), 'utf-8'),
        fs.readFile(path.join(pyDir, 'README.md'), 'utf-8'),
      ]);
      res.json({ script, requirements, readme });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to read Python script files',
      });
    }
  });

  // Download complete Python CLI bundle pre-configured with active UI settings
  app.post('/api/python/download-bundle', async (req, res) => {
    try {
      const pyDir = path.resolve(process.cwd(), 'python');
      const [script, requirements, readme] = await Promise.all([
        fs.readFile(path.join(pyDir, 'anonymize_pdfs.py'), 'utf-8'),
        fs.readFile(path.join(pyDir, 'requirements.txt'), 'utf-8'),
        fs.readFile(path.join(pyDir, 'README.md'), 'utf-8'),
      ]);

      const mode = String(req.body?.mode || 'mask_and_replace');
      const entities = Array.isArray(req.body?.entities)
        ? req.body.entities.join(',')
        : 'PERSON,SIN,CANADIAN_BANK_ACCOUNT,ADDRESS,PHONE,EMAIL,CREDIT_CARD,DOB,LEGAL_CASE_ID,PASSPORT';
      const minConfidence = Number(req.body?.minConfidence ?? 0.85).toFixed(2);
      const consistentFlag = req.body?.consistentMapping ? ' --consistent' : '';
      const seed = Number(req.body?.seed ?? 42);
      const inputDir = String(req.body?.inputFolderLabel || './input_pdfs');
      const outputDir = String(req.body?.outputFolderLabel || './anonymized_pdfs');

      const runSh = `#!/usr/bin/env bash
set -euo pipefail

# Configured from RedactBatch Workspace
python3 -m pip install -r requirements.txt
python3 anonymize_pdfs.py \\
  --input-dir "${inputDir}" \\
  --output-dir "${outputDir}" \\
  --recursive \\
  --mode "${mode}" \\
  --entities "${entities}" \\
  --min-confidence ${minConfidence} \\
  --seed ${seed}${consistentFlag} \\
  --workers 8
`;

      const zip = new JSZip();
      zip.file('anonymize_pdfs.py', script);
      zip.file('requirements.txt', requirements);
      zip.file('README.md', readme);
      zip.file('run_batch.sh', runSh);

      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="redactbatch-python-cli.zip"');
      res.send(zipBuffer);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to package Python CLI bundle',
      });
    }
  });

  // Ensure API errors and unmatched /api routes always return JSON instead of HTML
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });

  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (req.path.startsWith('/api')) {
        const message = err instanceof Error ? err.message : 'Internal server error';
        return res.status(500).json({ error: message });
      }
      next(err);
    }
  );

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`RedactBatch server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
