import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Eye, EyeOff, Unlock, UnlockKeyhole } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { androidExportFileName, UNLOCK_FAILED_MESSAGE } from '../../services/androidParity';
import { unlockPDF } from '../../services/pdfDocument';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { PDFFile, ProcessingStatus } from '../../types';
import { Button, StatusLine } from '../UI/Primitives';
import { FileUpload } from '../UI/FileUpload';
import { StatusToast } from '../UI/StatusToast';
import { ToolHeader, ToolPanel, ToolShell } from '../UI/ToolLayout';

const EMPTY_STATUS: ProcessingStatus = { isProcessing: false, progress: 0, message: '' };

export const UnlockPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState<ProcessingStatus>(EMPTY_STATUS);

  const reset = () => {
    setFile(null);
    setPassword('');
    setShowPassword(false);
    setStatus(EMPTY_STATUS);
  };

  const handleFilesSelected = (files: File[]) => {
    const selected = files[0];
    if (!selected || !isPdfFile(selected)) {
      setStatus({ ...EMPTY_STATUS, error: t("unlock-pdf.choose.a.password.protected.pdf.aa9d0e") });
      return;
    }

    setFile({ id: uuidv4(), file: selected, name: selected.name, size: selected.size });
    setPassword('');
    setShowPassword(false);
    setStatus(EMPTY_STATUS);
  };

  const handleUnlock = async () => {
    // Any non-empty string is a valid candidate, including whitespace-only passwords.
    if (!file || password.length === 0 || status.isProcessing) return;

    setStatus({ isProcessing: true, progress: 10, message: t("unlock-pdf.checking.the.password.on.this.device.9727b5") });
    try {
      const pdfBytes = await unlockPDF(file.file, password);
      const outputName = androidExportFileName('unlock', file.name, 'pdf');
      downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }), outputName);

      setPassword('');
      setShowPassword(false);
      setStatus({
        isProcessing: false,
        progress: 100,
        message: t("unlock-pdf.unlocked.copy.ready.85550a", { v0: outputName }),
      });
    } catch {
      // Keep the Android wording and never surface an error that could include the credential.
      setStatus({ ...EMPTY_STATUS, error: t("android-parity.unable.to.unlock.pdf.check.password.and.5aefc8") });
    }
  };

  return (
    <ToolShell centered={!file}>
      <ToolHeader title={t("unlock-pdf.unlock.pdf.893947")} />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div
            key="upload"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("unlock-pdf.choose.a.locked.pdf.a2cdfa")} />
          </motion.div>
        ) : (
          <motion.div
            key="unlock"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mx-auto flex max-w-md flex-col gap-3"
          >
            <ToolPanel className="flex items-start gap-2.5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]">
                <UnlockKeyhole aria-hidden size={18} />
              </span>
              <div className="min-w-0">
                <h2 className="chef-filename text-sm font-semibold text-[var(--text-primary)]">{file.name}</h2>
              </div>
            </ToolPanel>

            {/* Kept: the export loses permission restrictions too, which the
                button label does not say. */}
            <StatusLine tone="info">{t("unlock-pdf.the.exported.copy.loses.its.password.and.3b2f40")}</StatusLine>

            <div>
              <label htmlFor="unlock-password" className="mb-1 block type-footnote font-semibold text-[var(--text-secondary)]">{t("unlock-pdf.enter.password.7014af")}</label>
              <div className="relative">
                <input
                  id="unlock-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    if (!status.isProcessing && (status.error || status.message)) setStatus(EMPTY_STATUS);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && password.length > 0) void handleUnlock();
                  }}
                  placeholder={t("unlock-pdf.current.password.72ed2b")}
                  autoComplete="current-password"
                  spellCheck={false}
                  aria-describedby="unlock-password-help"
                  className="chef-field pr-12"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? t("unlock-pdf.hide.password.a60a56") : t("unlock-pdf.show.password.6aeaa6")}
                  className="absolute inset-y-0 right-0 grid w-12 place-items-center rounded-r-[var(--radius-field)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                >
                  {showPassword ? <EyeOff aria-hidden size={19} /> : <Eye aria-hidden size={19} />}
                </button>
              </div>
              <p id="unlock-password-help" className="type-caption mt-1 font-normal normal-case tracking-normal text-[var(--text-tertiary)]">{t("unlock-pdf.leading.trailing.and.whitespace.only.passwords.are.f7b1c0")}</p>
            </div>

            <div className="flex flex-col gap-2">
              <Button
                tone="primary"
                block
                busy={status.isProcessing}
                disabled={password.length === 0}
                icon={<Unlock aria-hidden size={18} />}
                onClick={() => void handleUnlock()}
              >{t("unlock-pdf.unlock.pdf.893947")}</Button>
              <Button tone="quiet" block onClick={reset} disabled={status.isProcessing}>{t("unlock-pdf.choose.another.file.26eac8")}</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <StatusToast status={status} />
    </ToolShell>
  );
};
