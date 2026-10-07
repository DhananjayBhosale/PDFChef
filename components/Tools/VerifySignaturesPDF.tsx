import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useOpenedPdf } from '../../hooks/useOpenedPdf';
import { useWorkspacePlatform } from '../../hooks/useWorkspaceRuntime';
import {
  IOS_MAXIMUM_SIGNATURE_VERIFICATION_BYTES,
  IOSSignatureVerificationSizeError,
} from '../../services/platform/capacitor/iosPdfReader';
import { Button, EmptyState, StatusLine } from '../UI/Primitives';
import { ToolHeader, ToolPanel, ToolShell } from '../UI/ToolLayout';

/** The native iOS and Android verifier, exposed as a first-class Tools entry. */
export const VerifySignaturesPDF: React.FC = () => {
  useI18n();
  const platform = useWorkspacePlatform();
  const navigate = useNavigate();
  const { setOpenedPdfFile } = useOpenedPdf();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<'too-large' | 'other' | null>(null);

  const reader = platform.pdfReader;
  const available = Boolean(
    platform.documentImport
    && reader?.supportsSignatureVerification,
  );

  const chooseAndVerify = async () => {
    if (!available || !reader || !platform.documentImport || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const imports = await platform.documentImport.importDocuments({
        acceptedMimeTypes: ['application/pdf'],
        maximumItems: 1,
      });
      const document = imports[0]?.document;
      if (!document) return;
      if (!reader.isEligible(document)) throw new Error('PDF is not eligible for native verification.');

      const result = await reader.open(document, { initialAction: 'verify-signatures' });
      if (result.action === 'tool') {
        const record = (await platform.records.list()).find(
          item => item.available && item.document?.ref === document.ref,
        );
        if (!record) throw new Error('The verified PDF is unavailable.');
        const opened = setOpenedPdfFile(await platform.reopen(record));
        navigate(result.toolPath, {
          state: { useOpenedPdf: true, openedPdfId: opened.id },
        });
      }
    } catch (error) {
      setFailure(error instanceof IOSSignatureVerificationSizeError ? 'too-large' : 'other');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ToolShell centered width="measure">
      <ToolHeader title={t("view-pdf.verify.pdf.signatures.93bd01")} />
      <ToolPanel>
        <EmptyState
          icon={<ShieldCheck size={32} />}
          title={available
            ? t("file-upload.choose.a.pdf.3ba70f")
            : t("dashboard.not.available.67a926")}
          action={available ? (
            <Button
              tone="primary"
              busy={busy}
              icon={<ShieldCheck aria-hidden size={18} />}
              onClick={() => void chooseAndVerify()}
            >
              {t("file-upload.choose.a.pdf.3ba70f")}
            </Button>
          ) : undefined}
        />
        {failure && (
          <div role="alert">
            <StatusLine tone="danger">
              {failure === 'too-large'
                ? `PDF > ${IOS_MAXIMUM_SIGNATURE_VERIFICATION_BYTES / (1024 * 1024)} MB`
                : t("view-pdf.signature.details.could.not.be.opened.for.2e56bb")}
            </StatusLine>
          </div>
        )}
      </ToolPanel>
    </ToolShell>
  );
};
