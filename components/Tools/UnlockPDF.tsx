import { t, formatPercent } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useRef, useState } from 'react';
import { Eye, EyeOff, Unlock, UnlockKeyhole } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { opensWithoutPassword, unlockPDF } from '../../services/pdfLazy';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { PDFFile, ProcessingStatus } from '../../types';
import { FileUpload } from '../UI/FileUpload';
import { formatBytes, toolOutputName } from '../UI/format';
import { ToolScreen, pressMainAction } from '../Tool/ToolScreen';
import { ChangeFile } from '../Tool/ToolTop';
import { Sentence } from '../Tool/Sentence';
import { FileStand, Notice, ProgressLine } from '../Tool/parts';
import { isConfirmEnter } from '../UI/keys';

const EMPTY_STATUS: ProcessingStatus = { isProcessing: false, progress: 0, message: '' };

export const UnlockPDF: React.FC = () => {
  useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState<ProcessingStatus>(EMPTY_STATUS);
  // Null while the file is checked. A PDF that opens without a password can still be locked
  // against changes; other tools send it here, and it unlocks with no password at all.
  const [needsPassword, setNeedsPassword] = useState<boolean | null>(null);
  const probeRef = useRef(0);

  const reset = () => {
    probeRef.current += 1;
    setFile(null);
    setNeedsPassword(null);
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

    const probe = probeRef.current + 1;
    probeRef.current = probe;
    setFile({ id: uuidv4(), file: selected, name: selected.name, size: selected.size });
    setNeedsPassword(null);
    setPassword('');
    setShowPassword(false);
    setStatus(EMPTY_STATUS);
    void opensWithoutPassword(selected).then((opens) => {
      if (probeRef.current === probe) setNeedsPassword(!opens);
    });
  };

  const handleUnlock = async () => {
    // Any non-empty string is a valid candidate, including whitespace-only passwords.
    if (!file || needsPassword === null || (needsPassword && password.length === 0) || status.isProcessing) return;

    setStatus({ isProcessing: true, progress: 10, message: t("unlock-pdf.checking.the.password.on.this.device.9727b5") });
    try {
      const pdfBytes = await unlockPDF(file.file, needsPassword ? password : '');
      const outputName = toolOutputName('unlock', file.name, 'pdf');
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

  const title = t("unlock-pdf.unlock.pdf.893947");

  if (!file) {
    return (
      <ToolScreen
        title={title}
        kind="form"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("unlock-pdf.choose.a.locked.pdf.a2cdfa")} error={status.error} />
          </div>
        )}
      />
    );
  }

  const notice = status.error
    ? <Notice tone="error" role="alert">{status.error}</Notice>
    : !status.isProcessing && status.progress === 100 && status.message
      ? <Notice role="status">{status.message}</Notice>
      : null;

  const form = needsPassword ? (
    <div className="tk-form">
      <div className="tk-field">
        <label htmlFor="unlock-password">{t("unlock-pdf.enter.password.7014af")}</label>
        {/* Why Unlock waits, inside the field's box as on Protect (research r2, H2-03). */}
        <div className="tk-hintfield tk-pwhint">
        <div className="tk-pw">
          <input
            id="unlock-password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              if (!status.isProcessing && (status.error || status.message)) setStatus(EMPTY_STATUS);
            }}
            onKeyDown={(event) => {
              // The same Enter must not also press the question's first button.
              if (isConfirmEnter(event) && password.length > 0 && pressMainAction(event.currentTarget)) event.preventDefault();
            }}
            placeholder={t("unlock-pdf.current.password.72ed2b")}
            autoComplete="current-password"
            spellCheck={false}
            disabled={status.isProcessing}
            aria-describedby="unlock-password-required unlock-password-help"
            className="chef-field"
          />
          <button
            type="button"
            onClick={() => setShowPassword((visible) => !visible)}
            aria-label={showPassword ? t("unlock-pdf.hide.password.a60a56") : t("unlock-pdf.show.password.6aeaa6")}
            className="chef-pressable"
          >
            {showPassword ? <EyeOff aria-hidden size={19} /> : <Eye aria-hidden size={19} />}
          </button>
        </div>
        {/* A wrong password's error replaces the hint, which would contradict it (research r3, H2-02). */}
        {!status.error && <span id="unlock-password-required" className="tk-hintfield-hint">{t("android-parity.password.is.required.to.unlock.the.pdf.be2e2e")}</span>}
        </div>
        <span id="unlock-password-help" className="sr-only">{t("unlock-pdf.leading.trailing.and.whitespace.only.passwords.are.f7b1c0")}</span>
      </div>
    </div>
  ) : undefined;

  return (
    <ToolScreen
      title={title}
      file={{ name: file.name, meta: formatBytes(file.size) }}
      heavyJob={{ bytes: file.size }}
      change={<ChangeFile label={t('tool.chooseAnotherFile')} onClick={reset} disabled={status.isProcessing} />}
      kind="form"
      bodyLabel={title}
      // A locked file cannot be drawn: its card stands in for the preview.
      body={<FileStand icon={<UnlockKeyhole aria-hidden />} />}
      side={form}
      // Kept: the export loses permission restrictions too, which the button label does not say.
      sentence={(
        <Sentence
          template="unlock-pdf.the.exported.copy.loses.its.password.and.3b2f40"
          groupLabel={t('sentence.groupLabel', { tool: title })}
          disabled={status.isProcessing}
        />
      )}
      notice={notice}
      action={(
        <button
          type="button"
          disabled={status.isProcessing || needsPassword === null || (needsPassword !== false && password.length === 0)}
          aria-describedby={needsPassword && password.length === 0 ? 'unlock-password-required' : undefined}
          onClick={() => void handleUnlock()}
          className="tk-primary chef-pressable"
        >
          <Unlock aria-hidden size={18} />
          <span>{title}</span>
        </button>
      )}
      progress={status.isProcessing ? (
        <ProgressLine label={status.message} percent={formatPercent(Math.max(0, Math.min(100, status.progress)))} value={status.progress} />
      ) : undefined}
    />
  );
};
