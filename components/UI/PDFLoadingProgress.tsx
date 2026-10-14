import React, { useId } from 'react';
import { FileText } from 'lucide-react';
import { formatPercent, t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import type { PdfPreviewProgress } from '../../services/pdfBrowser';

/** Count completed previews only; PDF opening and single-page rendering have no reliable percentage. */
export const PDFLoadingProgress: React.FC<{
  progress?: PdfPreviewProgress | null;
  pageNumber?: number;
  lazy?: boolean;
}> = ({ progress, pageNumber, lazy }) => {
  useI18n();
  const id = useId();
  const total = progress?.total ?? 0;
  const completed = Math.max(0, Math.min(total, progress?.completed ?? 0));
  const percent = total > 0 ? completed / total * 100 : undefined;
  const title = pageNumber ? t('preview-progress.page', { page: pageNumber })
    : progress ? t('preview-progress.preparing') : t('preview-progress.opening');
  const count = total > 0 ? t('preview-progress.count', { completed, total }) : undefined;

  return (
    <div data-pdf-loading-progress className="mx-auto my-4 w-full max-w-lg rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-4 text-[var(--text-primary)]">
      <div className="mb-3 flex items-center gap-3">
        <div aria-hidden="true" className="chef-preview-paper relative grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--accent-quiet)] text-[var(--accent-text)]">
          <FileText size={26} strokeWidth={1.7} />
          <span className="absolute -end-1 -top-1 h-2.5 w-2.5 rounded-full bg-[var(--accent-rest)]" />
        </div>
        <p id={`${id}-label`} role="status" className="min-w-0 flex-1 text-sm font-semibold">{title}</p>
        {percent !== undefined && <span aria-hidden="true" className="shrink-0 text-sm font-bold tabular-nums text-[var(--accent-text)]">{formatPercent(percent)}</span>}
      </div>
      <progress className="sr-only" max={100} value={percent} aria-labelledby={`${id}-label`} aria-describedby={`${id}-detail`} aria-valuetext={count} />
      <div aria-hidden="true" className="h-2.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
        <div className={`chef-preview-fill h-full rounded-full bg-[var(--accent-rest)]${percent === undefined ? ' chef-preview-indeterminate' : ''}`} style={percent === undefined ? undefined : { width: `${percent}%` }} />
      </div>
      <p id={`${id}-detail`} className="mt-2 text-xs text-[var(--text-secondary)]">{count ?? t('preview-progress.hint')}</p>
      {lazy && <p className="mt-1 text-xs text-[var(--text-secondary)]">{t('preview-progress.lazy')}</p>}
    </div>
  );
};
