import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOpenedPdf } from '../../hooks/useOpenedPdf';
import { useWorkspacePlatform } from '../../hooks/useWorkspaceRuntime';
import { t } from '../../services/i18n/core';
import { useI18n } from '../../services/i18n/react';

/** Continues an iOS Open-In document only when the native reader chose a web tool. */
export const IosIncomingPdfHandler = () => {
  useI18n();
  const platform = useWorkspacePlatform();
  const { setOpenedPdfFile } = useOpenedPdf();
  const navigate = useNavigate();
  const [continuing, setContinuing] = useState(false);

  useEffect(() => {
    const handoffs = platform.pdfOpenHandoffs;
    if (!handoffs) return undefined;

    let stopped = false;
    let stop: (() => Promise<void>) | null = null;
    void handoffs.start(async ({ record, toolPath }) => {
      if (stopped) return;
      setContinuing(true);
      try {
        const file = await platform.reopen(record);
        if (stopped) return;
        const opened = setOpenedPdfFile(file);
        if (toolPath === '/view') {
          navigate('/view');
        } else {
          navigate(toolPath, { state: { useOpenedPdf: true, openedPdfId: opened.id } });
        }
      } finally {
        if (!stopped) setContinuing(false);
      }
    }).then(nextStop => {
      if (stopped) void nextStop();
      else stop = nextStop;
    }).catch(() => {
      // The durable inbox item remains in Recents if a continuation cannot start.
    });

    return () => {
      stopped = true;
      void stop?.();
    };
  }, [navigate, platform, setOpenedPdfFile]);

  if (!continuing) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="fixed inset-0 z-[190] flex items-center justify-center bg-[color:var(--surface-canvas)]/92 px-6 backdrop-blur-sm"
    >
      <div className="flex items-center gap-3 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] px-5 py-4 shadow-[var(--shadow-floating)]">
        <span aria-hidden className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--accent-soft)] border-t-[var(--accent)] motion-reduce:animate-none" />
        <span className="font-semibold text-[var(--text-primary)]">{t('app.opening.the.tool.51992c')}</span>
      </div>
    </div>
  );
};
