import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOpenedPdf } from '../../hooks/useOpenedPdf';
import { useWorkspacePlatform } from '../../hooks/useWorkspaceRuntime';
import { AndroidDocumentsClient, isAndroidDocumentsAvailable } from '../../services/platform/android/androidDocuments';
import { openIncomingAndroidPdf } from '../../services/platform/android/openIncomingPdf';

export const AndroidIncomingPdfHandler = () => {
  useI18n();
  const platform = useWorkspacePlatform();
  const navigate = useNavigate();
  const { setOpenedPdfFile } = useOpenedPdf();
  const openFile = useRef(setOpenedPdfFile);
  openFile.current = setOpenedPdfFile;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isAndroidDocumentsAvailable()) return;
    let disposed = false;
    let queue = Promise.resolve();
    const listener = new AndroidDocumentsClient().addIncomingPdfListener(ref => {
      queue = queue.catch(() => undefined).then(async () => {
        if (disposed) return;
        setFailed(false);
        try {
          await openIncomingAndroidPdf(platform, ref, (file, toolPath) => {
            if (disposed) return;
            const opened = openFile.current(file);
            navigate(toolPath, { state: { useOpenedPdf: true, openedPdfId: opened.id } });
          });
        } catch {
          if (!disposed) setFailed(true);
        }
      });
    });
    void listener.catch(() => { if (!disposed) setFailed(true); });
    return () => {
      disposed = true;
      void listener.then(remove => remove()).catch(() => undefined);
    };
  }, [navigate, platform]);

  if (!failed) return null;
  return <div role="alert" className="fixed left-4 right-4 top-4 z-[200] rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-4 shadow-lg">
    <p>{t("android-incoming-pdf-handler.the.incoming.pdf.could.not.be.opened.9b5b95")}</p>
    <button type="button" onClick={() => setFailed(false)} className="mt-2 min-h-11 underline">{t("android-incoming-pdf-handler.dismiss.48845b")}</button>
  </div>;
};
