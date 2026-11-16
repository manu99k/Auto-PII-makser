import { useEffect, useState } from 'react';
import { Check, Copy, Download, Terminal } from 'lucide-react';
import type { BatchConfig } from '../types';

interface PythonCliViewProps {
  config: BatchConfig;
  inputFolderLabel: string;
  outputFolderLabel: string;
  onDownloadBundle: () => void;
}

export function PythonCliView({
  config,
  inputFolderLabel,
  outputFolderLabel,
  onDownloadBundle,
}: PythonCliViewProps) {
  const [files, setFiles] = useState<{
    script: string;
    requirements: string;
    readme: string;
  } | null>(null);
  const [activeFile, setActiveFile] = useState<'script' | 'requirements' | 'readme'>('script');
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  useEffect(() => {
    fetch('/api/python/files')
      .then((r) => r.json())
      .then((data) => {
        if (data.script) setFiles(data);
      })
      .catch(() => {
        // Handled cleanly
      });
  }, []);

  const entitiesArg = config.entities.join(',') || 'PERSON,SIN,CANADIAN_BANK_ACCOUNT,ADDRESS,PHONE,EMAIL,CREDIT_CARD,LEGAL_CASE_ID';
  const consistentArg = config.consistentMapping ? ' \\\n  --consistent' : '';
  const cibcArg = config.ignoreCibcEmployees === false ? ' \\\n  --no-ignore-cibc-employees' : ' \\\n  --ignore-cibc-employees';
  const cliCommand = `python3 anonymize_pdfs.py \\
  --input-dir "${inputFolderLabel || './input_pdfs'}" \\
  --output-dir "${outputFolderLabel || './anonymized_pdfs'}" \\
  --recursive \\
  --mode "${config.mode}" \\
  --entities "${entitiesArg}" \\
  --min-confidence ${config.minConfidence.toFixed(2)} \\
  --seed ${config.seed}${consistentArg}${cibcArg} \\
  --workers 8`;

  const copyCommand = async () => {
    await navigator.clipboard.writeText(cliCommand);
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 1800);
  };

  const activeContent =
    activeFile === 'script'
      ? files?.script || 'Loading anonymize_pdfs.py...'
      : activeFile === 'requirements'
      ? files?.requirements || 'Loading requirements.txt...'
      : files?.readme || 'Loading README.md...';

  const copyCode = async () => {
    await navigator.clipboard.writeText(activeContent);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 1800);
  };

  return (
    <div className="space-y-5">
      {/* Tailored CLI Invocation Card */}
      <section className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">
              Production Python Batch CLI (1 to 1,000+ PDFs)
            </h1>
            <p className="text-sm text-slate-500 mt-1 max-w-2xl leading-relaxed">
              Uses PyMuPDF (<span className="font-mono text-slate-700">fitz</span>) redaction annotations to irreversibly delete original PII bytes from PDF content streams, inserts deterministic <span className="font-mono text-slate-700">Faker</span> mock data at exact coordinates, and scales across CPU cores with <span className="font-mono text-slate-700">ProcessPoolExecutor</span>.
            </p>
          </div>

          <button
            type="button"
            onClick={onDownloadBundle}
            className="flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors shrink-0 whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            Download Python Bundle (.zip)
          </button>
        </div>

        <div className="bg-slate-900 rounded-lg border border-slate-800 p-4">
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-300">
              <Terminal className="w-3.5 h-3.5 text-slate-400" />
              <span>CLI Command (Synced with Current Workspace Configuration)</span>
            </div>
            <button
              type="button"
              onClick={copyCommand}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded transition-colors"
            >
              {copiedCmd ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copy Command
                </>
              )}
            </button>
          </div>
          <pre className="text-xs font-mono text-slate-100 overflow-x-auto leading-relaxed">
            {cliCommand}
          </pre>
        </div>
      </section>

      {/* Source Code Inspector */}
      <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md self-start">
            {(
              [
                { id: 'script', label: 'anonymize_pdfs.py' },
                { id: 'requirements', label: 'requirements.txt' },
                { id: 'readme', label: 'README.md' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveFile(tab.id)}
                className={`px-3 py-1 text-xs font-mono font-medium rounded transition-colors whitespace-nowrap ${
                  activeFile === tab.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={copyCode}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-md hover:bg-slate-50 transition-colors self-start sm:self-auto"
          >
            {copiedCode ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-600" />
                Copied File
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                Copy File
              </>
            )}
          </button>
        </div>

        <pre className="p-5 text-xs font-mono text-slate-800 bg-slate-50/60 overflow-auto max-h-[580px] leading-relaxed">
          {activeContent}
        </pre>
      </section>
    </div>
  );
}
