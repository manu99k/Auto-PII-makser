import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, FileSearch } from 'lucide-react';
import type { BatchJobResult, ProcessedFileResult } from '../types';
import { PdfPageCanvas } from './PdfPageCanvas';

interface InspectionDiffViewProps {
  workspaceId: string;
  jobResult: BatchJobResult | null;
  selectedRelativePath: string | null;
  onSelectFile: (relativePath: string) => void;
  onBackToWorkspace: () => void;
}

export function InspectionDiffView({
  workspaceId,
  jobResult,
  selectedRelativePath,
  onSelectFile,
  onBackToWorkspace,
}: InspectionDiffViewProps) {
  const [pageNumber, setPageNumber] = useState(1);
  const [numPages, setNumPages] = useState(1);
  const [viewMode, setViewMode] = useState<'visual' | 'text'>('visual');
  const [entityFilter, setEntityFilter] = useState<string>('ALL');

  const completedFiles = useMemo(
    () => (jobResult ? jobResult.files.filter((f) => f.status === 'completed') : []),
    [jobResult]
  );

  const activeFile: ProcessedFileResult | null = useMemo(() => {
    if (completedFiles.length === 0) return null;
    if (selectedRelativePath) {
      const match = completedFiles.find((f) => f.relativePath === selectedRelativePath);
      if (match) return match;
    }
    return completedFiles[0];
  }, [completedFiles, selectedRelativePath]);

  useEffect(() => {
    setPageNumber(1);
    setEntityFilter('ALL');
  }, [activeFile?.relativePath]);

  const entityTypesInFile = useMemo(() => {
    if (!activeFile) return [];
    const set = new Set(activeFile.occurrences.map((o) => o.entityType));
    return Array.from(set);
  }, [activeFile]);

  const filteredOccurrences = useMemo(() => {
    if (!activeFile) return [];
    if (entityFilter === 'ALL') return activeFile.occurrences;
    return activeFile.occurrences.filter((o) => o.entityType === entityFilter);
  }, [activeFile, entityFilter]);

  if (!jobResult || !activeFile) {
    return (
      <section className="bg-white border border-slate-200 rounded-lg p-12 text-center">
        <div className="mx-auto w-11 h-11 rounded-lg bg-slate-100 flex items-center justify-center mb-4">
          <FileSearch className="w-5 h-5 text-slate-600" />
        </div>
        <h2 className="text-base font-semibold text-slate-900 mb-1.5">
          No anonymized PDF available to inspect yet
        </h2>
        <p className="text-sm text-slate-500 max-w-md mx-auto mb-6">
          Run a batch anonymization job first to compare original input PDFs against the masked and mock-replaced output files.
        </p>
        <button
          type="button"
          onClick={onBackToWorkspace}
          className="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors"
        >
          Go to Batch Workspace
        </button>
      </section>
    );
  }

  const inputPdfUrl = `/api/workspace/${workspaceId}/pdf?side=input&path=${encodeURIComponent(
    activeFile.relativePath
  )}`;
  const outputPdfUrl = `/api/workspace/${workspaceId}/pdf?side=output&path=${encodeURIComponent(
    activeFile.relativePath
  )}`;

  return (
    <div className="space-y-5">
      {/* Control Header */}
      <section className="bg-white border border-slate-200 rounded-lg p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <select
            value={activeFile.relativePath}
            onChange={(e) => onSelectFile(e.target.value)}
            aria-label="Select inspected PDF file"
            className="px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-md bg-white text-slate-900 focus:outline-none focus:border-blue-600 max-w-sm"
          >
            {completedFiles.map((file) => (
              <option key={file.relativePath} value={file.relativePath}>
                {file.relativePath} ({file.entitiesMasked} masked)
              </option>
            ))}
          </select>

          <div className="flex items-center gap-2 text-xs text-slate-500 tabular-nums">
            <span>{activeFile.pages} page(s)</span>
            <span aria-hidden="true">·</span>
            <span>{activeFile.entitiesMasked} PII masked</span>
            <span aria-hidden="true">·</span>
            <span
              className={
                activeFile.streamVerifiedClean ? 'text-emerald-700 font-medium' : 'text-amber-700 font-medium'
              }
            >
              {activeFile.streamVerifiedClean ? 'Stream Verified Clean' : 'Visual Mask Applied'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            <button
              type="button"
              onClick={() => setViewMode('visual')}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                viewMode === 'visual'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Visual PDF Diff
            </button>
            <button
              type="button"
              onClick={() => setViewMode('text')}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                viewMode === 'text'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Extracted Text Diff
            </button>
          </div>

          {viewMode === 'visual' && (
            <div className="flex items-center gap-1.5 border border-slate-200 rounded-md px-2 py-1 bg-white">
              <button
                type="button"
                disabled={pageNumber <= 1}
                onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
                className="p-0.5 text-slate-600 hover:text-slate-900 disabled:opacity-35"
                aria-label="Previous page"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs font-mono tabular-nums text-slate-700 px-1">
                {pageNumber} / {Math.max(1, numPages)}
              </span>
              <button
                type="button"
                disabled={pageNumber >= numPages}
                onClick={() => setPageNumber((p) => Math.min(numPages, p + 1))}
                className="p-0.5 text-slate-600 hover:text-slate-900 disabled:opacity-35"
                aria-label="Next page"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          <a
            href={`/api/workspace/${workspaceId}/download-file?path=${encodeURIComponent(
              activeFile.relativePath
            )}`}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            Download Anonymized PDF
          </a>
        </div>
      </section>

      {/* Side-by-Side Comparison */}
      {viewMode === 'visual' ? (
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <PdfPageCanvas
            url={inputPdfUrl}
            pageNumber={pageNumber}
            label={`Input PDF (${jobResult.inputFolderLabel})`}
            onNumPages={(n) => setNumPages(n)}
          />
          <PdfPageCanvas
            url={outputPdfUrl}
            pageNumber={pageNumber}
            label={`Anonymized Output PDF (${jobResult.outputFolderLabel})`}
          />
        </section>
      ) : (
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <h3 className="text-xs font-semibold text-slate-700 mb-2">
              Extracted Text — Original Input PDF
            </h3>
            <pre className="text-xs font-mono text-slate-800 bg-slate-50 border border-slate-200 rounded p-3 overflow-auto max-h-[460px] whitespace-pre-wrap leading-relaxed">
              {activeFile.originalTextPreview || 'No selectable text extracted.'}
            </pre>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <h3 className="text-xs font-semibold text-slate-700 mb-2">
              Extracted Text — Anonymized Output PDF
            </h3>
            <pre className="text-xs font-mono text-slate-800 bg-slate-50 border border-slate-200 rounded p-3 overflow-auto max-h-[460px] whitespace-pre-wrap leading-relaxed">
              {activeFile.anonymizedTextPreview || 'No selectable text extracted.'}
            </pre>
          </div>
        </section>
      )}

      {/* Entity Mapping Table */}
      <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Detected PII Masking & Mock Replacement Ledger
            </h3>
            <p className="text-xs text-slate-500">
              {filteredOccurrences.length} replacement record(s) in {activeFile.filename}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-md self-start">
            <button
              type="button"
              onClick={() => setEntityFilter('ALL')}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                entityFilter === 'ALL'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              All
            </button>
            {entityTypesInFile.map((etype) => (
              <button
                key={etype}
                type="button"
                onClick={() => setEntityFilter(etype)}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                  entityFilter === etype
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {etype}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold text-slate-600">
                <th className="py-2.5 px-4">Page</th>
                <th className="py-2.5 px-3">Entity Type</th>
                <th className="py-2.5 px-3">Original PII Detected</th>
                <th className="py-2.5 px-3">Replaced Mock PII</th>
                <th className="py-2.5 px-3 text-right">Coordinates (x, y, w, h)</th>
                <th className="py-2.5 px-4 text-right">Confidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {filteredOccurrences.map((occ) => (
                <tr key={occ.id} className="hover:bg-slate-50/70">
                  <td className="py-2.5 px-4 font-mono tabular-nums text-slate-600">
                    {occ.page}
                  </td>
                  <td className="py-2.5 px-3 font-medium text-slate-800">
                    {occ.ruleLabel ? `${occ.entityType} (${occ.ruleLabel})` : occ.entityType}
                  </td>
                  <td className="py-2.5 px-3 font-mono text-red-700 bg-red-50/30">
                    {occ.original}
                  </td>
                  <td className="py-2.5 px-3 font-mono text-emerald-800 bg-emerald-50/30">
                    {occ.replacement}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-500">
                    {occ.bbox.x}, {occ.bbox.y}, {occ.bbox.width}×{occ.bbox.height}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-600">
                    {Math.round(occ.confidence * 100)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
