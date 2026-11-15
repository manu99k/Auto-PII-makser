import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfPageCanvasProps {
  url: string;
  pageNumber: number;
  label: string;
  onNumPages?: (numPages: number) => void;
}

export function PdfPageCanvas({
  url,
  pageNumber,
  label,
  onNumPages,
}: PdfPageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
    let renderTask: pdfjsLib.RenderTask | null = null;

    async function renderPage() {
      setLoading(true);
      setError(null);
      try {
        loadingTask = pdfjsLib.getDocument({ url });
        const doc = await loadingTask.promise;
        if (cancelled) {
          await loadingTask.destroy();
          return;
        }
        onNumPages?.(doc.numPages);
        const safePage = Math.max(1, Math.min(pageNumber, doc.numPages));
        const page = await doc.getPage(safePage);
        if (cancelled) {
          await loadingTask.destroy();
          return;
        }

        const containerWidth = containerRef.current?.clientWidth || 520;
        const baseViewport = page.getViewport({ scale: 1.0 });
        const targetScale = Math.max(0.5, Math.min(1.8, (containerWidth - 24) / baseViewport.width));
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: targetScale * dpr });

        const canvas = canvasRef.current;
        if (!canvas) {
          await loadingTask.destroy();
          return;
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          await loadingTask.destroy();
          return;
        }

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

        renderTask = page.render({
          canvasContext: ctx,
          viewport,
          canvas,
        });
        await renderTask.promise;
        await loadingTask.destroy();
        if (!cancelled) setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to render PDF preview');
          setLoading(false);
        }
      }
    }

    renderPage();

    return () => {
      cancelled = true;
      try {
        renderTask?.cancel();
      } catch {
        // Ignore cancellation
      }
      try {
        loadingTask?.destroy();
      } catch {
        // Ignore cleanup
      }
    };
  }, [url, pageNumber]);

  return (
    <div
      ref={containerRef}
      className="flex flex-col items-center justify-start bg-slate-100/80 border border-slate-200 rounded-lg p-3 min-h-[480px]"
    >
      <div className="w-full flex items-center justify-between mb-2.5 px-1">
        <span className="text-xs font-medium text-slate-600">{label}</span>
        <span className="text-xs font-mono tabular-nums text-slate-500">
          Page {pageNumber}
        </span>
      </div>

      {error ? (
        <div className="flex-1 flex items-center justify-center text-center px-6 py-12 text-sm text-red-700">
          {error}
        </div>
      ) : (
        <div className="relative flex items-center justify-center w-full">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-100/75 z-10 text-xs text-slate-500">
              Rendering PDF page...
            </div>
          )}
          <canvas
            ref={canvasRef}
            className="bg-white shadow-sm border border-slate-200 rounded-sm max-w-full"
          />
        </div>
      )}
    </div>
  );
}
