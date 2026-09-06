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
    if (password.length > 0 && !passwordHasText) return 'Password is required to protect a PDF.';
    if (password.length > 0 && password.length < 4) return 'Use at least 4 characters.';
    if (confirmationMismatch) return 'Confirmation does not match the password.';
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
      setStatus({ ...EMPTY_STATUS, error: 'Choose a PDF file to protect.' });
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

    setStatus({ isProcessing: true, progress: 10, message: 'Encrypting PDF on this device...' });

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
        message: `Protected copy ready: ${outputName}.`,
      });
    } catch {
      // Do not expose a worker/CLI error because it may contain invocation arguments.
      setStatus({
        ...EMPTY_STATUS,
        error: 'This PDF could not be protected. If it already has a password, unlock it first.',
      });
    }
  };

  return (
    <ToolShell centered={!file}>
      <ToolHeader title="Protect PDF" />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div
            key="upload"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label="Choose a PDF to protect" />
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
                <p className="type-footnote mt-0.5 text-[var(--text-secondary)]">
                  Passwords cannot be recovered, so keep yours somewhere safe.
                </p>
              </div>
            </ToolPanel>

            {/* Kept: a PDF password is weaker than users assume. The
                "encryption happens on this device" half is gone, because the
                privacy boundary is already stated once for the whole app. */}
            <StatusLine tone="info">
              A PDF password is not protection against copying, printing, or screenshots.
            </StatusLine>

            <div className="space-y-2.5">
              <div>
                <label htmlFor="protect-password" className="mb-1 block type-footnote font-semibold text-[var(--text-secondary)]">
                  Set password
                </label>
                <div className="relative">
                  <input
                    id="protect-password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      clearTerminalStatus();
                    }}
                    placeholder="Enter password"
                    autoComplete="new-password"
                    spellCheck={false}
                    aria-describedby="protect-password-help"
                    className="chef-field pr-12"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((visible) => !visible)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute inset-y-0 right-0 grid w-12 place-items-center rounded-r-[var(--radius-field)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                  >
                    {showPassword ? <EyeOff aria-hidden size={19} /> : <Eye aria-hidden size={19} />}
                  </button>
                </div>
                <p id="protect-password-help" className="type-caption mt-1 font-normal normal-case tracking-normal text-[var(--text-tertiary)]">
                  At least 4 characters, with spaces preserved exactly.
                </p>
              </div>

              <div>
                <label htmlFor="protect-password-confirmation" className="mb-1 block type-footnote font-semibold text-[var(--text-secondary)]">
                  Confirm password <span className="font-normal text-[var(--text-tertiary)]">(optional)</span>
                </label>
                <div className="relative">
                  <input
                    id="protect-password-confirmation"
                    aria-label="Confirm Password"
                    type={showConfirmation ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(event) => {
                      setConfirmPassword(event.target.value);
                      clearTerminalStatus();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && canProtect) void handleProtect();
                    }}
                    placeholder="Enter the same password"
                    autoComplete="new-password"
                    spellCheck={false}
                    aria-describedby={validationMessage ? 'protect-password-validation' : undefined}
                    className="chef-field pr-12"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmation((visible) => !visible)}
                    aria-label={showConfirmation ? 'Hide confirmation password' : 'Show confirmation password'}
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
              >
                Encrypt PDF
              </Button>
              <Button tone="quiet" block onClick={reset} disabled={status.isProcessing}>
                Choose another file
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <StatusToast status={status} />
    </ToolShell>
  );
};
