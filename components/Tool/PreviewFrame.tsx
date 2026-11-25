import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';

/**
 * The one frame every page preview uses (T-13): zoom or expand at the top end, outside the
 * page; the page; the pager at the bottom centre; then the position pill. Watermark, Page
 * Numbers, Crop, PDF to Image and Header & Footer. With a position pill (a phone), the tools sit
 * at the end of the pill's row instead of a row of their own, so the page gets that room (pass 3).
 */
export const PreviewFrame: React.FC<{
  tools?: React.ReactNode;
  pager?: React.ReactNode;
  foot?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ tools, pager, foot, className, children }) => (
  <div className={`tk-pframe${className ? ` ${className}` : ''}`}>
    {tools && !foot && <div className="tk-pframe-tools">{tools}</div>}
    {children}
    {pager}
    {foot && (
      <div className="tk-stagefoot" data-tools={tools ? '' : undefined}>
        {foot}
        {tools && <div className="tk-pframe-tools">{tools}</div>}
      </div>
    )}
  </div>
);

/** "‹ Page 1 of 3 ›" under a preview. Nothing for a one-page file. */
export const PagePager: React.FC<{
  index: number;
  total: number;
  onChange: (index: number) => void;
  disabled?: boolean;
}> = ({ index, total, onChange, disabled }) => {
  useI18n();
  if (total <= 1) return null;
  return (
    <div className="tk-pager">
      <button
        type="button"
        onClick={() => onChange(Math.max(0, index - 1))}
        disabled={disabled || index <= 0}
        aria-label={t("page-numbers-pdf.previous.preview.page.030555")}
        className="chef-pressable"
      >
        <ChevronLeft aria-hidden size={18} className="rtl:rotate-180" />
      </button>
      <span className="tabular">{t("compare-pdf.page.of.477c22", { v0: index + 1, v1: total })}</span>
      <button
        type="button"
        onClick={() => onChange(Math.min(total - 1, index + 1))}
        disabled={disabled || index >= total - 1}
        aria-label={t("page-numbers-pdf.next.preview.page.48ae03")}
        className="chef-pressable"
      >
        <ChevronRight aria-hidden size={18} className="rtl:rotate-180" />
      </button>
    </div>
  );
};
