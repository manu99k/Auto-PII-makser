import { useMemo } from 'react';
import { Download, FileJson } from 'lucide-react';
import type { BatchJobResult } from '../types';

interface AuditManifestViewProps {
  jobResult: BatchJobResult | null;
  onBackToWorkspace: () => void;
}

export function AuditManifestView({
  jobResult,
  onBackToWorkspace,
}: AuditManifestViewProps) {
  const entityTotals = useMemo(() => {
    if (!jobResult) return [];
    const totals: Record<string, number> = {};
    for (const file of jobResult.files) {
      for (const [k, v] of Object.entries(file.entityCounts)) {
        totals[k] = (totals[k] ?? 0) + v;
      }
    }
    return Object.entries(totals).sort((a, b) => b[1] - a[1]);
  }, [jobResult]);

  const maxCount = entityTotals[0]?.[1] || 1;

  if (!jobResult) {
    return (
      <section className="bg-white border border-slate-200 rounded-lg p-12 text-center">
        <div className="mx-auto w-11 h-11 rounded-lg bg-slate-100 flex items-center justify-center mb-4">
          <FileJson className="w-5 h-5 text-slate-600" />
        </div>
        <h2 className="text-base font-semibold text-slate-900 mb-1.5">
          No batch audit manifest generated yet
        </h2>
        <p className="text-sm text-slate-500 max-w-md mx-auto mb-6">
          Run an anonymization batch to generate a complete audit manifest detailing processed PDFs, masked PII categories, and stream verification status.
        </p>
        <button
          type="button"
          onClick={onBackToWorkspace}
          className="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors"
        >
          Return to Workspace
        </button>
      </section>
    );
  }

  const downloadManifestJson = () => {
    const blob = new Blob([JSON.stringify(jobResult, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `anonymization_manifest_${jobResult.jobId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      {/* Top Metrics Row */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <span className="block text-xs text-slate-500">Files Anonymized</span>
          <span className="block text-2xl font-semibold text-slate-900 mt-1 font-mono tabular-nums">
            {jobResult.succeeded} / {jobResult.totalFiles}
          </span>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <span className="block text-xs text-slate-500">Total PII Masked & Replaced</span>
          <span className="block text-2xl font-semibold text-slate-900 mt-1 font-mono tabular-nums">
            {jobResult.totalPiiMasked}
          </span>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <span className="block text-xs text-slate-500">Consistent Mapping</span>
          <span className="block text-2xl font-semibold text-slate-900 mt-1">
            {jobResult.config.consistentMapping ? 'Enabled' : 'Randomized'}
          </span>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <span className="block text-xs text-slate-500">Batch Duration</span>
          <span className="block text-2xl font-semibold text-slate-900 mt-1 font-mono tabular-nums">
            {(jobResult.elapsedMs / 1000).toFixed(2)}s
          </span>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Entity Distribution */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-slate-900 mb-4">
            Masked PII Breakdown by Entity Type
          </h3>
          {entityTotals.length === 0 ? (
            <p className="text-xs text-slate-500">No entities detected in this batch.</p>
          ) : (
            <div className="space-y-3">
              {entityTotals.map(([etype, count]) => (
                <div key={etype}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-medium text-slate-700">{etype}</span>
                    <span className="font-mono tabular-nums text-slate-600">{count}</span>
                  </div>
                  <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-700 rounded-full"
                      style={{ width: `${Math.max(4, (count / maxCount) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Raw JSON Manifest */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                anonymization_manifest.json
              </h3>
              <p className="text-xs text-slate-500">
                Saved inside {jobResult.outputFolderLabel}
              </p>
            </div>
            <button
              type="button"
              onClick={downloadManifestJson}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 border border-slate-300 rounded-md hover:bg-slate-50 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Export JSON
            </button>
          </div>
          <pre className="p-4 text-xs font-mono text-slate-800 bg-slate-50/70 overflow-auto max-h-[420px] leading-relaxed">
            {JSON.stringify(
              {
                ...jobResult,
                files: jobResult.files.map((f) => ({
                  relativePath: f.relativePath,
                  pages: f.pages,
                  entitiesMasked: f.entitiesMasked,
                  streamVerifiedClean: f.streamVerifiedClean,
                  entityCounts: f.entityCounts,
                  elapsedMs: f.elapsedMs,
                  status: f.status,
                })),
              },
              null,
              2
            )}
          </pre>
        </section>
      </div>
    </div>
  );
}
