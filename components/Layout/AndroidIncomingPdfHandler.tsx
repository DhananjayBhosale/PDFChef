import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOpenedPdf } from '../../hooks/useOpenedPdf';
import { useWorkspacePlatform } from '../../hooks/useWorkspaceRuntime';
import { AndroidDocumentsClient, isAndroidDocumentsAvailable, type IncomingPdfRejection } from '../../services/platform/android/androidDocuments';
import { openIncomingAndroidPdf } from '../../services/platform/android/openIncomingPdf';
import { announceRecordsChanged } from '../../services/workspace';

/** 'failed' is a copy that arrived but would not open; the rest are files Android refused. */
type IncomingNotice = 'failed' | IncomingPdfRejection;

const noticeText = (notice: IncomingNotice) => {
  if (notice === 'tooLarge') return t("android-incoming-pdf-handler.this.pdf.is.too.large.to.open.080096");
  if (notice === 'notPdf') return t('error.pdfNotPdf');
  if (notice === 'other') return t("android-incoming-pdf-handler.this.file.could.not.be.opened.bf6e8b");
  return t("android-incoming-pdf-handler.the.incoming.pdf.could.not.be.opened.9b5b95");
};

export const AndroidIncomingPdfHandler = () => {
  useI18n();
  const platform = useWorkspacePlatform();
  const navigate = useNavigate();
  const { setOpenedPdfFile } = useOpenedPdf();
  const openFile = useRef(setOpenedPdfFile);
  openFile.current = setOpenedPdfFile;
  const [notice, setNotice] = useState<IncomingNotice | null>(null);

  useEffect(() => {
    if (!isAndroidDocumentsAvailable()) return;
    let disposed = false;
    let queue = Promise.resolve();
    const client = new AndroidDocumentsClient();
    // Without this, "Open with PDF Chef" on a file Android refused seemed to do nothing.
    const rejected = client.addIncomingPdfRejectedListener(reason => {
      if (!disposed) setNotice(reason);
    });
    // The PDF was opened from another app straight in the native reader; this is the tool
    // the person then chose there.
    const listener = client.addIncomingPdfListener((ref, toolPath) => {
      queue = queue.catch(() => undefined).then(async () => {
        if (disposed) return;
        setNotice(null);
        // The handed-over copy is already a Recent row; a Recent screen that is open now shows it.
        announceRecordsChanged();
        try {
          await openIncomingAndroidPdf(platform, ref, toolPath, (file, path) => {
            if (disposed) return;
            const opened = openFile.current(file);
            navigate(path, { state: { useOpenedPdf: true, openedPdfId: opened.id } });
          });
        } catch {
          if (!disposed) setNotice('failed');
        }
      });
    });
    void listener.catch(() => { if (!disposed) setNotice('failed'); });
    void rejected.catch(() => undefined);
    return () => {
      disposed = true;
      void listener.then(remove => remove()).catch(() => undefined);
      void rejected.then(remove => remove()).catch(() => undefined);
    };
  }, [navigate, platform]);

  if (!notice) return null;
  return <div role="alert" className="fixed left-4 right-4 top-[calc(1rem+env(safe-area-inset-top))] z-[200] rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-4 shadow-lg">
    <p>{noticeText(notice)}</p>
    <button type="button" onClick={() => setNotice(null)} className="mt-2 min-h-11 underline">{t("android-incoming-pdf-handler.dismiss.48845b")}</button>
  </div>;
};
