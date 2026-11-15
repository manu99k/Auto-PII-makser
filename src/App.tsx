import { useCallback, useState } from 'react';
import { Download } from 'lucide-react';
import { AuditManifestView } from './components/AuditManifestView';
import { BatchWorkspaceView } from './components/BatchWorkspaceView';
import { InspectionDiffView } from './components/InspectionDiffView';
import { PythonCliView } from './components/PythonCliView';
import type {
  BatchConfig,
  BatchJobResult,
  UploadedFileSummary,
} from './types';

type ActiveTab = 'workspace' | 'inspect' | 'python' | 'manifest';

const INITIAL_CONFIG: BatchConfig = {
  mode: 'mask_and_replace',
  entities: [
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
  ],
  minConfidence: 0.85,
  consistentMapping: true,
  seed: 42,
  customRules: [],
  scrubStream: true,
};

function generateWorkspaceId(): string {
  return `ws-${Math.random().toString(36).slice(2, 10)}`;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('workspace');
  const [workspaceId] = useState<string>(generateWorkspaceId);
  const [stagedFiles, setStagedFiles] = useState<UploadedFileSummary[]>([]);
  const [jobResult, setJobResult] = useState<BatchJobResult | null>(null);
  const [selectedInspectPath, setSelectedInspectPath] = useState<string | null>(null);
  const [config, setConfig] = useState<BatchConfig>(INITIAL_CONFIG);
  const [inputFolderLabel, setInputFolderLabel] = useState('./input_pdfs');
  const [outputFolderLabel, setOutputFolderLabel] = useState('./anonymized_pdfs');
  const [isUploading, setIsUploading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const readJsonSafe = async (res: Response) => {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `Server returned HTTP ${res.status} (${res.statusText || 'Error'}): ${text.slice(0, 140)}`
      );
    }
  };

  const handleUploadFiles = useCallback(
    async (fileList: FileList, replaceExisting: boolean) => {
      setErrorMessage(null);
      setIsUploading(true);
      try {
        const pdfFiles: File[] = [];
        const relativePaths: string[] = [];

        for (let i = 0; i < fileList.length; i++) {
          const file = fileList[i];
          if (!file.name.toLowerCase().endsWith('.pdf')) continue;
          pdfFiles.push(file);
          const rel =
            (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
            file.name;
          relativePaths.push(rel);
        }

        if (pdfFiles.length === 0) {
          setErrorMessage('No .pdf files found in the selected folder or files.');
          return;
        }

        // Upload in size-and-count-bounded chunks (max 25 files or 35MB per request)
        const MAX_CHUNK_FILES = 25;
        const MAX_CHUNK_BYTES = 35 * 1024 * 1024;
        let latestFiles: UploadedFileSummary[] = [];
        let index = 0;
        let chunkIndex = 0;

        while (index < pdfFiles.length) {
          const chunkFiles: File[] = [];
          const chunkPaths: string[] = [];
          let chunkBytes = 0;

          while (index < pdfFiles.length) {
            const nextFile = pdfFiles[index];
            if (
              chunkFiles.length > 0 &&
              (chunkFiles.length >= MAX_CHUNK_FILES ||
                chunkBytes + nextFile.size > MAX_CHUNK_BYTES)
            ) {
              break;
            }
            chunkFiles.push(nextFile);
            chunkPaths.push(relativePaths[index]);
            chunkBytes += nextFile.size;
            index++;
          }

          const form = new FormData();
          form.append('workspaceId', workspaceId);
          form.append('replaceExisting', String(replaceExisting && chunkIndex === 0));
          form.append('relativePaths', JSON.stringify(chunkPaths));

          for (const f of chunkFiles) {
            form.append('files', f);
          }

          const res = await fetch('/api/workspace/upload', {
            method: 'POST',
            body: form,
          });
          const data = await readJsonSafe(res);
          if (!res.ok) {
            throw new Error(data.error || 'Failed to upload PDFs');
          }
          latestFiles = data.files || [];
          chunkIndex++;
        }

        setStagedFiles(latestFiles);
        setJobResult(null);
        setSelectedInspectPath(null);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Upload failed');
      } finally {
        setIsUploading(false);
      }
    },
    [workspaceId]
  );

  const handleGenerateSamples = useCallback(
    async (count: number) => {
      setErrorMessage(null);
      setIsUploading(true);
      try {
        const res = await fetch('/api/workspace/samples', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            count,
            replaceExisting: true,
          }),
        });
        const data = await readJsonSafe(res);
        if (!res.ok) {
          throw new Error(data.error || 'Failed to generate sample PDFs');
        }
        setStagedFiles(data.files || []);
        setJobResult(null);
        setSelectedInspectPath(null);
      } catch (err) {
        setErrorMessage(
          err instanceof Error ? err.message : 'Sample generation failed'
        );
      } finally {
        setIsUploading(false);
      }
    },
    [workspaceId]
  );

  const handleClearFiles = useCallback(async () => {
    setErrorMessage(null);
    try {
      await fetch(`/api/workspace/${workspaceId}/files`, { method: 'DELETE' });
      setStagedFiles([]);
      setJobResult(null);
      setSelectedInspectPath(null);
    } catch {
      setErrorMessage('Failed to clear staged PDF queue');
    }
  }, [workspaceId]);

  const handleRunBatch = useCallback(async () => {
    setErrorMessage(null);
    setIsProcessing(true);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config,
          inputFolderLabel,
          outputFolderLabel,
        }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) {
        throw new Error(data.error || 'Batch anonymization failed');
      }
      setJobResult(data as BatchJobResult);
      const firstOk = (data as BatchJobResult).files.find(
        (f) => f.status === 'completed'
      );
      if (firstOk) {
        setSelectedInspectPath(firstOk.relativePath);
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Batch processing failed'
      );
    } finally {
      setIsProcessing(false);
    }
  }, [workspaceId, config, inputFolderLabel, outputFolderLabel]);

  const handleDownloadPythonBundle = useCallback(async () => {
    try {
      const res = await fetch('/api/python/download-bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: config.mode,
          entities: config.entities,
          minConfidence: config.minConfidence,
          consistentMapping: config.consistentMapping,
          seed: config.seed,
          inputFolderLabel,
          outputFolderLabel,
        }),
      });
      if (!res.ok) throw new Error('Failed to generate Python CLI bundle');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'redactbatch-python-cli.zip';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Download failed'
      );
    }
  }, [config, inputFolderLabel, outputFolderLabel]);

  const handleInspectFile = useCallback((relativePath: string) => {
    setSelectedInspectPath(relativePath);
    setActiveTab('inspect');
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Strict 3-Zone Top Bar */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-[1380px] mx-auto px-6 h-14 flex items-center justify-between gap-8">
          <button
            type="button"
            onClick={() => setActiveTab('workspace')}
            className="font-display text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            RedactBatch
          </button>

          <nav className="flex items-center gap-6 overflow-x-auto">
            {(
              [
                { id: 'workspace', label: 'Batch Workspace' },
                { id: 'inspect', label: 'Inspection & Diff' },
                { id: 'python', label: 'Python CLI Tool' },
                { id: 'manifest', label: 'Audit Manifest' },
              ] as const
            ).map((nav) => {
              const active = activeTab === nav.id;
              return (
                <button
                  key={nav.id}
                  type="button"
                  onClick={() => setActiveTab(nav.id)}
                  className={`py-4 text-xs font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                    active
                      ? 'border-blue-700 text-slate-900'
                      : 'border-transparent text-slate-500 hover:text-slate-900'
                  }`}
                >
                  {nav.label}
                </button>
              );
            })}
          </nav>

          <button
            type="button"
            onClick={handleDownloadPythonBundle}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Download Python CLI
          </button>
        </div>
      </header>

      {/* Main Content Container */}
      <div className="flex-1 max-w-[1380px] w-full mx-auto px-6 py-6">
        {activeTab === 'workspace' && (
          <BatchWorkspaceView
            workspaceId={workspaceId}
            stagedFiles={stagedFiles}
            jobResult={jobResult}
            config={config}
            inputFolderLabel={inputFolderLabel}
            outputFolderLabel={outputFolderLabel}
            isUploading={isUploading}
            isProcessing={isProcessing}
            errorMessage={errorMessage}
            onConfigChange={setConfig}
            onInputFolderLabelChange={setInputFolderLabel}
            onOutputFolderLabelChange={setOutputFolderLabel}
            onUploadFiles={handleUploadFiles}
            onGenerateSamples={handleGenerateSamples}
            onClearFiles={handleClearFiles}
            onRunBatch={handleRunBatch}
            onInspectFile={handleInspectFile}
          />
        )}

        {activeTab === 'inspect' && (
          <InspectionDiffView
            workspaceId={workspaceId}
            jobResult={jobResult}
            selectedRelativePath={selectedInspectPath}
            onSelectFile={setSelectedInspectPath}
            onBackToWorkspace={() => setActiveTab('workspace')}
          />
        )}

        {activeTab === 'python' && (
          <PythonCliView
            config={config}
            inputFolderLabel={inputFolderLabel}
            outputFolderLabel={outputFolderLabel}
            onDownloadBundle={handleDownloadPythonBundle}
          />
        )}

        {activeTab === 'manifest' && (
          <AuditManifestView
            jobResult={jobResult}
            onBackToWorkspace={() => setActiveTab('workspace')}
          />
        )}
      </div>
    </div>
  );
}
