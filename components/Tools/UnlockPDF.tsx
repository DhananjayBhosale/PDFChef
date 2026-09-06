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
      setStatus({ ...EMPTY_STATUS, error: 'Choose a password-protected PDF.' });
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

    setStatus({ isProcessing: true, progress: 10, message: 'Checking the password on this device...' });
    try {
      const pdfBytes = await unlockPDF(file.file, password);
      const outputName = androidExportFileName('unlock', file.name, 'pdf');
      downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }), outputName);

      setPassword('');
      setShowPassword(false);
      setStatus({
        isProcessing: false,
        progress: 100,
        message: `Unlocked copy ready: ${outputName}.`,
      });
    } catch {
      // Keep the Android wording and never surface an error that could include the credential.
      setStatus({ ...EMPTY_STATUS, error: UNLOCK_FAILED_MESSAGE });
    }
  };

  return (
    <ToolShell centered={!file}>
      <ToolHeader title="Unlock PDF" />

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div
            key="upload"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label="Choose a locked PDF" />
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
            <StatusLine tone="info">
              The exported copy loses its password and permission restrictions; your original is unchanged.
            </StatusLine>

            <div>
              <label htmlFor="unlock-password" className="mb-1 block type-footnote font-semibold text-[var(--text-secondary)]">
                Enter password
              </label>
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
                  placeholder="Current password"
                  autoComplete="current-password"
                  spellCheck={false}
                  aria-describedby="unlock-password-help"
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
              <p id="unlock-password-help" className="type-caption mt-1 font-normal normal-case tracking-normal text-[var(--text-tertiary)]">
                Leading, trailing, and whitespace-only passwords are preserved exactly.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Button
                tone="primary"
                block
                busy={status.isProcessing}
                disabled={password.length === 0}
                icon={<Unlock aria-hidden size={18} />}
                onClick={() => void handleUnlock()}
              >
                Unlock PDF
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
