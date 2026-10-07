import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { PDFFile, ProcessingStatus } from '../../types';
import { androidExportFileName } from '../../services/androidParity';
import { protectPDF } from '../../services/pdfDocument';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { Button, StatusLine } from '../UI/Primitives';
import { FileUpload } from '../UI/FileUpload';
import { StatusToast } from '../UI/StatusToast';
import { ToolHeader, ToolPanel, ToolShell } from '../UI/ToolLayout';

const EMPTY_STATUS: ProcessingStatus = { isProcessing: false, progress: 0, message: '' };

export const SecurityPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [status, setStatus] = useState<ProcessingStatus>(EMPTY_STATUS);

  // Match Android's isNotBlank check without normalizing the credential itself.
  const passwordHasText = /\S/.test(password);
  const confirmationProvided = /\S/.test(confirmPassword);
  const confirmationMismatch = confirmationProvided && confirmPassword !== password;
  const canProtect = passwordHasText && password.length >= 4 && !confirmationMismatch;

  const validationMessage = (() => {
    if (password.length > 0 && !passwordHasText) return t("security-pdf.password.is.required.to.protect.a.pdf.5153a4");
    if (password.length > 0 && password.length < 4) return t("security-pdf.use.at.least.4.characters.b679db");
    if (confirmationMismatch) return t("security-pdf.confirmation.does.not.match.the.password.9f4d85");
    return null;
  })();

  const clearTerminalStatus = () => {
    if (!status.isProcessing && (status.error || status.message)) setStatus(EMPTY_STATUS);
  };

  const reset = () => {
    setFile(null);
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
    setShowConfirmation(false);
    setStatus(EMPTY_STATUS);
  };

  const handleFilesSelected = (files: File[]) => {
    const selected = files[0];
    if (!selected || !isPdfFile(selected)) {
      setStatus({ ...EMPTY_STATUS, error: t("security-pdf.choose.a.pdf.file.to.protect.f593c9") });
      return;
    }

    setFile({
      id: uuidv4(),
      file: selected,
      name: selected.name,
      size: selected.size,
    });
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
    setShowConfirmation(false);
    setStatus(EMPTY_STATUS);
  };

  const handleProtect = async () => {
    if (!file || !canProtect || status.isProcessing) return;

    setStatus({ isProcessing: true, progress: 10, message: t("security-pdf.encrypting.pdf.on.this.device.af1739") });

    try {
      const pdfBytes = await protectPDF(file.file, password);
      const outputName = androidExportFileName('protect', file.name, 'pdf');
      downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }), outputName);

      // Credentials are needed only for this operation. Do not keep them in the finished screen.
      setPassword('');
      setConfirmPassword('');
      setShowPassword(false);
      setShowConfirmation(false);
      setStatus({
        isProcessing: false,
        progress: 100,
        message: t("security-pdf.protected.copy.ready.3fad41", { v0: outputName }),
      });
    } catch {
      // Do not expose a worker/CLI error because it may contain invocation arguments.
      setStatus({
        ...EMPTY_STATUS,
        error: t("security-pdf.this.pdf.could.not.be.protected.if.2430e7"),
      });
    }
  };

  return (
    <ToolShell centered={!file}>
      <ToolHeader title={t("security-pdf.protect.pdf.dae6c6")} />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div
            key="upload"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("security-pdf.choose.a.pdf.to.protect.3d9782")} />
          </motion.div>
        ) : (
          <motion.div
            key="protect"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mx-auto flex max-w-md flex-col gap-3"
          >
            <ToolPanel className="flex items-start gap-2.5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]">
                <ShieldCheck aria-hidden size={18} />
              </span>
              <div className="min-w-0">
                <h2 className="chef-filename text-sm font-semibold text-[var(--text-primary)]">{file.name}</h2>
                {/* Kept: there is no recovery path for a lost PDF password. */}
                <p className="type-footnote mt-0.5 text-[var(--text-secondary)]">{t("security-pdf.passwords.cannot.be.recovered.so.keep.yours.ce35f0")}</p>
              </div>
            </ToolPanel>

            {/* Kept: a PDF password is weaker than users assume. The
                "encryption happens on this device" half is gone, because the
                privacy boundary is already stated once for the whole app. */}
            <StatusLine tone="info">{t("security-pdf.a.pdf.password.is.not.protection.against.0e6855")}</StatusLine>

            <div className="space-y-2.5">
              <div>
                <label htmlFor="protect-password" className="mb-1 block type-footnote font-semibold text-[var(--text-secondary)]">{t("security-pdf.set.password.4e4116")}</label>
                <div className="relative">
                  <input
                    id="protect-password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      clearTerminalStatus();
                    }}
                    placeholder={t("security-pdf.enter.password.7014af")}
                    autoComplete="new-password"
                    spellCheck={false}
                    aria-describedby="protect-password-help"
                    className="chef-field pr-12"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((visible) => !visible)}
                    aria-label={showPassword ? t("security-pdf.hide.password.a60a56") : t("security-pdf.show.password.6aeaa6")}
                    className="absolute inset-y-0 right-0 grid w-12 place-items-center rounded-r-[var(--radius-field)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                  >
                    {showPassword ? <EyeOff aria-hidden size={19} /> : <Eye aria-hidden size={19} />}
                  </button>
                </div>
                <p id="protect-password-help" className="type-caption mt-1 font-normal normal-case tracking-normal text-[var(--text-tertiary)]">{t("security-pdf.at.least.4.characters.with.spaces.preserved.e0bf40")}</p>
              </div>

              <div>
                <label htmlFor="protect-password-confirmation" className="mb-1 block type-footnote font-semibold text-[var(--text-secondary)]">{t("security-pdf.confirm.password.b186eb")}<span className="font-normal text-[var(--text-tertiary)]">{t("security-pdf.optional.005979")}</span>
                </label>
                <div className="relative">
                  <input
                    id="protect-password-confirmation"
                    aria-label={t("security-pdf.confirm.password.c29221")}
                    type={showConfirmation ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(event) => {
                      setConfirmPassword(event.target.value);
                      clearTerminalStatus();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && canProtect) void handleProtect();
                    }}
                    placeholder={t("security-pdf.enter.the.same.password.938872")}
                    autoComplete="new-password"
                    spellCheck={false}
                    aria-describedby={validationMessage ? 'protect-password-validation' : undefined}
                    className="chef-field pr-12"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmation((visible) => !visible)}
                    aria-label={showConfirmation ? t("security-pdf.hide.confirmation.password.0c2fc3") : t("security-pdf.show.confirmation.password.d8144e")}
                    className="absolute inset-y-0 right-0 grid w-12 place-items-center rounded-r-[var(--radius-field)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                  >
                    {showConfirmation ? <EyeOff aria-hidden size={19} /> : <Eye aria-hidden size={19} />}
                  </button>
                </div>
              </div>

              {validationMessage && (
                <p id="protect-password-validation" role="status" className="text-sm font-medium text-[var(--status-caution-text)]">
                  {validationMessage}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Button
                tone="primary"
                block
                busy={status.isProcessing}
                disabled={!canProtect}
                icon={<Lock aria-hidden size={18} />}
                onClick={() => void handleProtect()}
              >{t("security-pdf.protect.with.password.b73965")}</Button>
              <Button tone="quiet" block onClick={reset} disabled={status.isProcessing}>{t("security-pdf.choose.another.file.26eac8")}</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <StatusToast status={status} />
    </ToolShell>
  );
};
