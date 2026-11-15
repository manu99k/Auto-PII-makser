import { useMemo, useRef, useState } from 'react';
import {
  Download,
  Eye,
  FileText,
  FolderInput,
  FolderOutput,
  Plus,
  Play,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  BatchConfig,
  BatchJobResult,
  CustomRule,
  PiiEntityType,
  ProcessedFileResult,
  RedactionMode,
  UploadedFileSummary,
} from '../types';

const ENTITY_OPTIONS: Array<{ id: PiiEntityType; label: string; example: string }> = [
  { id: 'PERSON', label: 'Client / Party Names', example: 'Margaret E. Vance' },
  { id: 'SIN', label: 'Canadian SIN (Luhn)', example: '482-910-338' },
  { id: 'CANADIAN_BANK_ACCOUNT', label: 'Bank / LIRA / Transit', example: '00412-003-8901234' },
  { id: 'ADDRESS', label: 'Canadian Address / Postal', example: 'Toronto, ON M5H 1J8' },
  { id: 'PHONE', label: 'Canadian Phone', example: '(416) 892-3410' },
  { id: 'EMAIL', label: 'Email Addresses', example: 'name@company.ca' },
  { id: 'CREDIT_CARD', label: 'Credit Cards (Luhn)', example: '4532-0151-...' },
  { id: 'DOB', label: 'DOB / Marriage Dates', example: '1984-08-25' },
  { id: 'LEGAL_CASE_ID', label: 'Court Docket / CRA BN', example: 'FS-24-0091842-0000' },
  { id: 'PASSPORT', label: 'Passport / Prov. DL', example: 'M4920-41829-20214' },
];

const MODE_OPTIONS: Array<{
  id: RedactionMode;
  title: string;
  desc: string;
}> = [
  {
    id: 'mask_and_replace',
    title: 'Mask + Mock PII',
    desc: 'Draws a masked frame, scrubs original stream bytes, and writes Faker mock PII inside.',
  },
  {
    id: 'whiteout_replace',
    title: 'Seamless Replace',
    desc: 'Whiteouts original PII coordinates and inserts realistic mock PII cleanly.',
  },
  {
    id: 'solid_mask',
    title: 'Solid Redaction Bar',
    desc: 'Masks PII with a solid dark redaction block labeled [REDACTED:TYPE].',
  },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

interface BatchWorkspaceViewProps {
  workspaceId: string;
  stagedFiles: UploadedFileSummary[];
  jobResult: BatchJobResult | null;
  config: BatchConfig;
  inputFolderLabel: string;
  outputFolderLabel: string;
  isUploading: boolean;
  isProcessing: boolean;
  errorMessage: string | null;
  onConfigChange: (next: BatchConfig) => void;
  onInputFolderLabelChange: (val: string) => void;
  onOutputFolderLabelChange: (val: string) => void;
  onUploadFiles: (files: FileList, replaceExisting: boolean) => void;
  onGenerateSamples: (count: number) => void;
  onClearFiles: () => void;
  onRunBatch: () => void;
  onInspectFile: (relativePath: string) => void;
}

export function BatchWorkspaceView({
  workspaceId,
  stagedFiles,
  jobResult,
  config,
  inputFolderLabel,
  outputFolderLabel,
  isUploading,
  isProcessing,
  errorMessage,
  onConfigChange,
  onInputFolderLabelChange,
  onOutputFolderLabelChange,
  onUploadFiles,
  onGenerateSamples,
  onClearFiles,
  onRunBatch,
  onInspectFile,
}: BatchWorkspaceViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'masked' | 'errors'>('all');
  const [newRuleLabel, setNewRuleLabel] = useState('');
  const [newRulePattern, setNewRulePattern] = useState('');
  const [newRuleMock, setNewRuleMock] = useState('EMP-#####');

  const toggleEntity = (entity: PiiEntityType) => {
    const exists = config.entities.includes(entity);
    const next = exists
      ? config.entities.filter((e) => e !== entity)
      : [...config.entities, entity];
    onConfigChange({ ...config, entities: next });
  };

  const addCustomRule = () => {
    if (!newRuleLabel.trim() || !newRulePattern.trim()) return;
    const rule: CustomRule = {
      id: `${Date.now()}`,
      label: newRuleLabel.trim(),
      pattern: newRulePattern.trim(),
      mockTemplate: newRuleMock.trim() || 'MOCK-######',
      enabled: true,
    };
    onConfigChange({
      ...config,
      customRules: [...config.customRules, rule],
    });
    setNewRuleLabel('');
    setNewRulePattern('');
  };

  const removeCustomRule = (id: string) => {
    onConfigChange({
      ...config,
      customRules: config.customRules.filter((r) => r.id !== id),
    });
  };

  const resultMap = useMemo(() => {
    const map = new Map<string, ProcessedFileResult>();
    if (jobResult) {
      for (const f of jobResult.files) {
        map.set(f.relativePath, f);
      }
    }
    return map;
  }, [jobResult]);

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return stagedFiles.filter((file) => {
      const processed = resultMap.get(file.relativePath);
      if (statusFilter === 'masked' && (!processed || processed.entitiesMasked === 0)) {
        return false;
      }
      if (statusFilter === 'errors' && (!processed || processed.status !== 'error')) {
        return false;
      }
      if (q && !file.relativePath.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [stagedFiles, resultMap, searchQuery, statusFilter]);

  const totalBytes = useMemo(
    () => stagedFiles.reduce((sum, f) => sum + f.sizeBytes, 0),
    [stagedFiles]
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Left Configuration Column */}
      <aside className="lg:col-span-4 space-y-5">
        {/* 01. Input Folder & Output Destination */}
        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-1">
            01. Source Folder & Output Directory
          </h2>
          <p className="text-xs text-slate-500 mb-4 leading-relaxed">
            Stage 1 to 1,000 PDFs from a folder or generate synthetic test documents.
          </p>

          <div className="space-y-3 mb-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Input Folder Path
              </label>
              <div className="flex items-center gap-2 border border-slate-200 rounded-md px-2.5 py-1.5 bg-slate-50/70">
                <FolderInput className="w-4 h-4 text-slate-400 shrink-0" />
                <input
                  type="text"
                  value={inputFolderLabel}
                  onChange={(e) => onInputFolderLabelChange(e.target.value)}
                  className="w-full bg-transparent text-xs font-mono text-slate-800 focus:outline-none"
                  placeholder="./input_pdfs"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Designated Output Directory
              </label>
              <div className="flex items-center gap-2 border border-slate-200 rounded-md px-2.5 py-1.5 bg-slate-50/70">
                <FolderOutput className="w-4 h-4 text-slate-400 shrink-0" />
                <input
                  type="text"
                  value={outputFolderLabel}
                  onChange={(e) => onOutputFolderLabelChange(e.target.value)}
                  className="w-full bg-transparent text-xs font-mono text-slate-800 focus:outline-none"
                  placeholder="./anonymized_pdfs"
                />
              </div>
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                onUploadFiles(e.target.files, false);
                e.target.value = '';
              }
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            accept=".pdf,application/pdf"
            multiple
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                onUploadFiles(e.target.files, true);
                e.target.value = '';
              }
            }}
          />

          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              disabled={isUploading || isProcessing}
              onClick={() => folderInputRef.current?.click()}
              className="flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              <FolderInput className="w-3.5 h-3.5 text-slate-600" />
              Select Folder
            </button>
            <button
              type="button"
              disabled={isUploading || isProcessing}
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              <Upload className="w-3.5 h-3.5 text-slate-600" />
              Add PDFs
            </button>
          </div>

          <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
            <span className="text-xs text-slate-500">Need test PDFs?</span>
            <div className="flex items-center gap-1.5">
              {[5, 25].map((count) => (
                <button
                  key={count}
                  type="button"
                  disabled={isUploading || isProcessing}
                  onClick={() => onGenerateSamples(count)}
                  className="px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50/70 hover:bg-blue-100/80 rounded transition-colors disabled:opacity-50 whitespace-nowrap"
                >
                  Load {count} Sample PDFs
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* 02. Masking & Mock Replacement Strategy */}
        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">
            02. Masking & Replacement Mode
          </h2>

          <div className="space-y-2 mb-4">
            {MODE_OPTIONS.map((opt) => {
              const active = config.mode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onConfigChange({ ...config, mode: opt.id })}
                  className={`w-full text-left p-3 rounded-md border transition-colors ${
                    active
                      ? 'border-blue-600 bg-blue-50/40'
                      : 'border-slate-200 hover:border-slate-300 bg-white'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-900">
                      {opt.title}
                    </span>
                    <span
                      className={`text-[11px] font-medium ${
                        active ? 'text-blue-700' : 'text-slate-400'
                      }`}
                    >
                      {active ? 'Selected' : 'Select'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                    {opt.desc}
                  </p>
                </button>
              );
            })}
          </div>

          <div className="space-y-2.5 pt-3 border-t border-slate-100">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={config.consistentMapping}
                onChange={(e) =>
                  onConfigChange({ ...config, consistentMapping: e.target.checked })
                }
                className="mt-0.5 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
              />
              <div>
                <span className="block text-xs font-medium text-slate-800">
                  Consistent Entity Pseudonymization
                </span>
                <span className="block text-xs text-slate-500">
                  Same original PII maps to the exact same mock value across all PDFs.
                </span>
              </div>
            </label>

            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={config.scrubStream}
                onChange={(e) =>
                  onConfigChange({ ...config, scrubStream: e.target.checked })
                }
                className="mt-0.5 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
              />
              <div>
                <span className="block text-xs font-medium text-slate-800">
                  Scrub Underlying PDF Stream Strings
                </span>
                <span className="block text-xs text-slate-500">
                  Removes matched ASCII literals from content streams before saving.
                </span>
              </div>
            </label>

            <div className="pt-2 border-t border-slate-100">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-slate-700">
                  Confidence Threshold (Default 0.85)
                </label>
                <input
                  type="number"
                  min={0.5}
                  max={0.99}
                  step={0.01}
                  value={config.minConfidence}
                  onChange={(e) => {
                    const v = Math.max(0.5, Math.min(0.99, Number(e.target.value) || 0.85));
                    onConfigChange({ ...config, minConfidence: v });
                  }}
                  className="w-20 px-2 py-1 text-xs font-mono tabular-nums border border-slate-200 rounded bg-white text-right text-slate-800 focus:outline-none focus:border-blue-600"
                />
              </div>
              <input
                type="range"
                min={0.5}
                max={0.99}
                step={0.01}
                value={config.minConfidence}
                onChange={(e) =>
                  onConfigChange({
                    ...config,
                    minConfidence: Number(e.target.value),
                  })
                }
                aria-label="Minimum PII detection confidence threshold"
                className="w-full accent-blue-700 cursor-pointer"
              />
              <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                Only detections scoring strictly above{' '}
                <span className="font-mono font-medium text-slate-700">
                  {config.minConfidence.toFixed(2)}
                </span>{' '}
                are masked. Lower to ~0.75 to catch unprefixed names and compact numbers.
              </p>
            </div>

            <div className="flex items-center justify-between pt-1">
              <label className="text-xs font-medium text-slate-700">
                Deterministic Seed
              </label>
              <input
                type="number"
                value={config.seed}
                onChange={(e) =>
                  onConfigChange({
                    ...config,
                    seed: Number(e.target.value) || 42,
                  })
                }
                className="w-24 px-2 py-1 text-xs font-mono tabular-nums border border-slate-200 rounded bg-white text-right text-slate-800 focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>
        </section>

        {/* 03. PII Entity Detectors */}
        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-900">
              03. PII Detectors ({config.entities.length}/{ENTITY_OPTIONS.length})
            </h2>
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() =>
                  onConfigChange({
                    ...config,
                    entities: ENTITY_OPTIONS.map((o) => o.id),
                  })
                }
                className="text-blue-700 hover:underline font-medium"
              >
                All
              </button>
              <span className="text-slate-300">·</span>
              <button
                type="button"
                onClick={() =>
                  onConfigChange({
                    ...config,
                    entities: ['PERSON', 'SIN', 'CANADIAN_BANK_ACCOUNT', 'ADDRESS', 'LEGAL_CASE_ID'],
                  })
                }
                className="text-slate-600 hover:text-slate-900"
              >
                Banking & Legal 5
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {ENTITY_OPTIONS.map((ent) => {
              const checked = config.entities.includes(ent.id);
              return (
                <label
                  key={ent.id}
                  className={`flex items-start gap-2 p-2 rounded border cursor-pointer transition-colors ${
                    checked
                      ? 'border-slate-300 bg-slate-50/70'
                      : 'border-slate-200/70 bg-white opacity-75'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleEntity(ent.id)}
                    className="mt-0.5 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                  />
                  <div className="min-w-0">
                    <span className="block text-xs font-medium text-slate-800 truncate">
                      {ent.label}
                    </span>
                    <span className="block text-[11px] font-mono text-slate-400 truncate">
                      {ent.example}
                    </span>
                  </div>
                </label>
              );
            })}
          </div>

          {/* Custom Regex Rule Adder */}
          <div className="mt-4 pt-4 border-t border-slate-100">
            <span className="block text-xs font-medium text-slate-800 mb-2">
              Custom Regex Rules
            </span>
            {config.customRules.length > 0 && (
              <div className="space-y-1.5 mb-2.5">
                {config.customRules.map((rule) => (
                  <div
                    key={rule.id}
                    className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded text-xs"
                  >
                    <div className="min-w-0">
                      <span className="font-medium text-slate-800">{rule.label}</span>
                      <span className="text-slate-400 mx-1.5">·</span>
                      <span className="font-mono text-slate-500 truncate">
                        /{rule.pattern}/
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeCustomRule(rule.id)}
                      className="text-slate-400 hover:text-red-600 shrink-0"
                      aria-label={`Remove ${rule.label}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-1 gap-2">
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  value={newRuleLabel}
                  onChange={(e) => setNewRuleLabel(e.target.value)}
                  placeholder="Label (e.g. Employee ID)"
                  className="px-2.5 py-1.5 text-xs border border-slate-200 rounded bg-white focus:outline-none focus:border-blue-600"
                />
                <input
                  type="text"
                  value={newRuleMock}
                  onChange={(e) => setNewRuleMock(e.target.value)}
                  placeholder="Mock (#=digit, ?=alpha)"
                  className="px-2.5 py-1.5 text-xs font-mono border border-slate-200 rounded bg-white focus:outline-none focus:border-blue-600"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newRulePattern}
                  onChange={(e) => setNewRulePattern(e.target.value)}
                  placeholder="Regex (e.g. EMP-\d{5})"
                  className="flex-1 px-2.5 py-1.5 text-xs font-mono border border-slate-200 rounded bg-white focus:outline-none focus:border-blue-600"
                />
                <button
                  type="button"
                  onClick={addCustomRule}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add
                </button>
              </div>
            </div>
          </div>
        </section>
      </aside>

      {/* Right Execution & Queue Column */}
      <main className="lg:col-span-8 space-y-5">
        {/* Batch Toolbar & Summary Strip */}
        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold text-slate-900">
                Batch PDF Anonymization Queue
              </h1>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mt-1 tabular-nums">
                <span>{stagedFiles.length} PDFs staged</span>
                <span aria-hidden="true">·</span>
                <span>{formatBytes(totalBytes)} total</span>
                {jobResult && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-emerald-700 font-medium">
                      {jobResult.totalPiiMasked} PII spans masked & replaced
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{(jobResult.elapsedMs / 1000).toFixed(2)}s</span>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              {stagedFiles.length > 0 && (
                <button
                  type="button"
                  disabled={isProcessing || isUploading}
                  onClick={onClearFiles}
                  className="px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-md hover:bg-slate-50 transition-colors disabled:opacity-50 whitespace-nowrap"
                >
                  Clear Queue
                </button>
              )}

              {jobResult && jobResult.succeeded > 0 && (
                <a
                  href={`/api/workspace/${workspaceId}/download-zip`}
                  className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download Output ZIP
                </a>
              )}

              <button
                type="button"
                disabled={stagedFiles.length === 0 || isProcessing || isUploading}
                onClick={onRunBatch}
                className="flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors disabled:opacity-50 whitespace-nowrap"
              >
                <Play className="w-3.5 h-3.5" />
                {isProcessing
                  ? 'Anonymizing Batch...'
                  : `Anonymize ${stagedFiles.length || ''} PDF${stagedFiles.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>

          {errorMessage && (
            <div className="mt-4 p-3 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">
              {errorMessage}
            </div>
          )}

          {/* Filter & Search Bar */}
          {stagedFiles.length > 0 && (
            <div className="mt-5 pt-4 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md self-start">
                {(
                  [
                    { id: 'all', label: `All (${stagedFiles.length})` },
                    {
                      id: 'masked',
                      label: `Masked (${
                        jobResult
                          ? jobResult.files.filter((f) => f.entitiesMasked > 0).length
                          : 0
                      })`,
                    },
                    {
                      id: 'errors',
                      label: `Errors (${jobResult ? jobResult.failed : 0})`,
                    },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setStatusFilter(tab.id)}
                    className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                      statusFilter === tab.id
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter files by folder or filename..."
                className="w-full sm:w-64 px-3 py-1.5 text-xs border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-600"
              />
            </div>
          )}
        </section>

        {/* Queue / Results Data Grid */}
        {stagedFiles.length === 0 ? (
          <section className="bg-white border border-slate-200 rounded-lg p-12 text-center">
            <div className="mx-auto w-11 h-11 rounded-lg bg-slate-100 flex items-center justify-center mb-4">
              <FileText className="w-5 h-5 text-slate-600" />
            </div>
            <h3 className="text-base font-semibold text-slate-900 mb-1.5">
              No PDF files staged in the input folder
            </h3>
            <p className="text-sm text-slate-500 max-w-md mx-auto mb-6 leading-relaxed">
              Select a folder containing 1 to 1,000 PDFs, drop individual files, or load a synthetic batch of PII-rich documents to test masking and mock replacement immediately.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                className="flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap"
              >
                <FolderInput className="w-3.5 h-3.5" />
                Select PDF Folder
              </button>
              <button
                type="button"
                onClick={() => onGenerateSamples(5)}
                className="flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Generate 5 Sample PII PDFs
              </button>
            </div>
          </section>
        ) : (
          <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold text-slate-600">
                    <th className="py-2.5 px-4">Document Path</th>
                    <th className="py-2.5 px-3 text-right">Size</th>
                    <th className="py-2.5 px-3 text-right">Pages</th>
                    <th className="py-2.5 px-3 text-right">PII Masked</th>
                    <th className="py-2.5 px-3">Verification</th>
                    <th className="py-2.5 px-3 text-right">Time</th>
                    <th className="py-2.5 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {filteredRows.map((file) => {
                    const res = resultMap.get(file.relativePath);
                    return (
                      <tr
                        key={file.relativePath}
                        className="hover:bg-slate-50/70 transition-colors"
                      >
                        <td className="py-2.5 px-4 font-mono text-slate-800 max-w-[260px] truncate">
                          {file.relativePath}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-500">
                          {formatBytes(file.sizeBytes)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600">
                          {res ? res.pages : '—'}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums font-medium text-slate-900">
                          {res ? res.entitiesMasked : 'Pending'}
                        </td>
                        <td className="py-2.5 px-3">
                          {!res ? (
                            <span className="text-slate-400">Queued</span>
                          ) : res.status === 'error' ? (
                            <span className="text-red-700 font-medium">
                              Error: {res.error}
                            </span>
                          ) : res.streamVerifiedClean ? (
                            <span className="text-emerald-700 font-medium">
                              Verified Clean
                            </span>
                          ) : (
                            <span className="text-amber-700 font-medium">
                              Masked Visually
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-500">
                          {res ? `${res.elapsedMs} ms` : '—'}
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          <div className="inline-flex items-center justify-end gap-2">
                            {res && res.status === 'completed' ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => onInspectFile(file.relativePath)}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 rounded transition-colors whitespace-nowrap"
                                >
                                  <Eye className="w-3.5 h-3.5" />
                                  Inspect
                                </button>
                                <a
                                  href={`/api/workspace/${workspaceId}/download-file?path=${encodeURIComponent(
                                    file.relativePath
                                  )}`}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded transition-colors whitespace-nowrap"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                  PDF
                                </a>
                              </>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
