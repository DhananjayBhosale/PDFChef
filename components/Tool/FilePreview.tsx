import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Eye, FileText } from 'lucide-react';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import { loadPDFDocument, renderPageAsImage } from '../../services/pdfLazy';
import { useReleasePdfDocument } from '../../hooks/useReleasePdfDocument';
import { FileCard } from './parts';
import { usePinchToOpen } from './PagePeek';
import { PDFPreviewModal } from '../UI/PDFPreviewModal';

/**
 * The first page of the loaded PDF, fitted in the canvas on the sunken backdrop, with
 * the file name and meta under it (plan 2.17). When it cannot be drawn (locked,
 * damaged, not a PDF) it is a file card with the tool's mark, the name and the size,
 * and no error text: the tool's own messages cover real failures.
 */
export const FilePreview: React.FC<{
  file: File;
  name?: string;
  meta?: React.ReactNode;
  icon?: React.ReactNode;
  /** The page count, once the file opens (Repair shows it in its header). */
  onPages?: (count: number) => void;
  /** The first page could not be drawn (Repair says it can still re-save). */
  onFailed?: () => void;
  /**
   * Draws a file that is not a PDF (PowerPoint's first slide, research r2 H3-03): resolves to an
   * object URL this preview revokes.
   */
  render?: (file: File) => Promise<string>;
  /** Shown instead of the file card when the first page cannot be drawn. */
  fallback?: React.ReactNode;
}> = ({ file, name = file.name, meta, icon, onPages, onFailed, render, fallback }) => {
  useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useReleasePdfDocument(file);
  const callbacks = useRef({ onPages, onFailed });
  callbacks.current = { onPages, onFailed };
  const renderRef = useRef(render);
  renderRef.current = render;
  // The page opens large (pass 5): a tap or a click on it, or two fingers spread on it, as Reorder's
  // eye does. The eye sits on the page's corner so the page reads as something to open.
  const [large, setLarge] = useState(false);
  const pinchRef = usePinchToOpen(() => setLarge(true));
  const pageRef = useRef<HTMLButtonElement | null>(null);
  const [badge, setBadge] = useState<React.CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    const box = pageRef.current;
    const img = box?.querySelector('img');
    if (!box || !img) return undefined;
    const place = () => {
      const outer = box.getBoundingClientRect();
      const pic = img.getBoundingClientRect();
      if (!pic.width) return;
      const rtl = getComputedStyle(box).direction === 'rtl';
      setBadge({
        top: pic.bottom - outer.top - 34,
        left: rtl ? pic.right - outer.left - 34 : pic.left - outer.left + 6,
      });
    };
    place();
    img.addEventListener('load', place);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(box);
    return () => { img.removeEventListener('load', place); observer?.disconnect(); };
  }, [url]);
  const setPage = (node: HTMLButtonElement | null) => {
    pageRef.current = node;
    pinchRef(node);
  };

  useEffect(() => {
    let active = true;
    let created: string | null = null;
    setUrl(null);
    setFailed(false);
    (async () => {
      try {
        let objectUrl: string;
        if (renderRef.current) {
          objectUrl = await renderRef.current(file);
        } else {
          const pdf = await loadPDFDocument(file);
          if (active) callbacks.current.onPages?.(pdf.numPages);
          const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
          ({ objectUrl } = await renderPageAsImage(pdf, 0, { scale, format: 'image/jpeg', quality: 0.9 }));
        }
        if (!active) { URL.revokeObjectURL(objectUrl); return; }
        created = objectUrl;
        setUrl(objectUrl);
      } catch {
        if (active) {
          setFailed(true);
          callbacks.current.onFailed?.();
        }
      }
    })();
    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [file]);

  if (failed) return fallback ? <>{fallback}</> : <FileCard icon={icon ?? <FileText size={20} />} name={name} meta={meta} />;

  return (
    <figure className="tk-filepreview">
      {url ? (
        <button
          ref={setPage}
          type="button"
          onClick={() => setLarge(true)}
          aria-label={t('reorder-pdf.preview.page.ffb7e0', { v0: 1 })}
          className="tk-filepreview-page tk-filepreview-open"
        >
          <img src={url} alt={t('file-preview.alt', { name })} draggable={false} />
          <span aria-hidden className="tk-peek-badge" style={badge ?? { visibility: 'hidden' }}><Eye size={14} /></span>
        </button>
      ) : (
        <div className="tk-filepreview-page" aria-busy>
          <span className="tk-filepreview-loading" role="status">{t('file-preview.loading')}</span>
        </div>
      )}
      <figcaption className="tk-filepreview-caption">
        <bdi className="tk-fname chef-filename" title={name}>{name}</bdi>
        {meta && <span className="tk-fmeta tabular">{meta}</span>}
      </figcaption>
      {large && url && (
        <PDFPreviewModal file={file} pageIndex={0} pageLabel={name} image={render ? url : undefined} onClose={() => setLarge(false)} />
      )}
    </figure>
  );
};
