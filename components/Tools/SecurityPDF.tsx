import { t, formatPercent } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useState } from 'react';
import { Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { PDFFile, ProcessingStatus } from '../../types';
import { pdfFileProblem, protectPDF } from '../../services/pdfLazy';
import { downloadBlob, isPdfFile } from '../../services/pdfShared';
import { FileUpload } from '../UI/FileUpload';
import { ErrorText } from '../UI/ErrorText';
import { formatBytes, toolOutputName } from '../UI/format';
import { ToolScreen, pressMainAction } from '../Tool/ToolScreen';
import { ChangeFile } from '../Tool/ToolTop';
import { Sentence } from '../Tool/Sentence';
import { Notice, ProgressLine } from '../Tool/parts';
import { FilePreview } from '../Tool/FilePreview';
import { isConfirmEnter } from '../UI/keys';

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

  // The rule (4 characters, spaces kept exactly) is drawn inside the password field at rest, so the
  // greyed button has its reason before anything is typed (research r1, mobile-05, desktop-12).
  // A password that breaks it turns that hint to the error tone; the notice line does not repeat it.
  const tooShort = passwordHasText && password.length < 4;
  const validationMessage = (() => {
    if (password.length > 0 && !passwordHasText) return t("security-pdf.password.is.required.to.protect.a.pdf.5153a4");
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
      const outputName = toolOutputName('protect', file.name, 'pdf');
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
    } catch (error) {
      // Do not expose a worker/CLI error because it may contain invocation arguments. When the
      // file is the cause (a password, not a PDF, damaged), say which, with the tool that helps.
      const problem = await pdfFileProblem(file.file, error).catch(() => null);
      setStatus({
        ...EMPTY_STATUS,
        error: problem ?? t("security-pdf.this.pdf.could.not.be.protected.if.2430e7"),
      });
    }
  };

  const title = t("security-pdf.protect.pdf.dae6c6");

  if (!file) {
    return (
      <ToolScreen
        title={title}
        kind="form"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("security-pdf.choose.a.pdf.to.protect.3d9782")} error={status.error} />
          </div>
        )}
      />
    );
  }

  const validationId = 'protect-password-validation';
  // First that applies: the failure, today's validation line, then the limit of a PDF password.
  const notice = status.error
    // The next tool it names (Unlock PDF, Repair PDF) is a link that takes the file along (r4 desktop-11).
    ? <Notice tone="error" role="alert"><ErrorText text={status.error} file={file?.file ?? null} /></Notice>
    : validationMessage
      ? <Notice tone="pending" id={validationId} role="status">{validationMessage}</Notice>
      : !status.isProcessing && status.progress === 100 && status.message
        ? <Notice role="status">{status.message}</Notice>
        : <Notice tone="caution">{t("security-pdf.a.pdf.password.is.not.protection.against.0e6855")}</Notice>;

  const form = (
    <div className="tk-form">
      <div className="tk-field">
        <label htmlFor="protect-password">{t("security-pdf.set.password.4e4116")}</label>
        <div className="tk-hintfield tk-pwhint">
        <div className="tk-pw">
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
            disabled={status.isProcessing}
            aria-describedby="protect-password-help"
            aria-invalid={tooShort || undefined}
            className="chef-field"
          />
          <button
            type="button"
            onClick={() => setShowPassword((visible) => !visible)}
            aria-label={showPassword ? t("security-pdf.hide.password.a60a56") : t("security-pdf.show.password.6aeaa6")}
            className="chef-pressable"
          >
            {showPassword ? <EyeOff aria-hidden size={19} /> : <Eye aria-hidden size={19} />}
          </button>
        </div>
        <span id="protect-password-help" className="tk-hintfield-hint" data-invalid={tooShort ? '' : undefined}>{t("security-pdf.at.least.4.characters.with.spaces.preserved.e0bf40")}</span>
        </div>
        {/* Said once when the typed password becomes too short (the hint above is its description). */}
        <span role="status" className="sr-only">{tooShort ? t("security-pdf.at.least.4.characters.with.spaces.preserved.e0bf40") : ''}</span>
      </div>

      <div className="tk-field">
        <label htmlFor="protect-password-confirmation">
          {t("security-pdf.confirm.password.b186eb")}
          <span className="tk-optional">{t("security-pdf.optional.005979")}</span>
        </label>
        <div className="tk-pw">
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
              // The same Enter must not also press the question's first button.
              if (isConfirmEnter(event) && canProtect && pressMainAction(event.currentTarget)) event.preventDefault();
            }}
            placeholder={t("security-pdf.enter.the.same.password.938872")}
            autoComplete="new-password"
            spellCheck={false}
            disabled={status.isProcessing}
            aria-describedby={validationMessage ? validationId : undefined}
            className="chef-field"
          />
          <button
            type="button"
            onClick={() => setShowConfirmation((visible) => !visible)}
            aria-label={showConfirmation ? t("security-pdf.hide.confirmation.password.0c2fc3") : t("security-pdf.show.confirmation.password.d8144e")}
            className="chef-pressable"
          >
            {showConfirmation ? <EyeOff aria-hidden size={19} /> : <Eye aria-hidden size={19} />}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <ToolScreen
      title={title}
      file={{ name: file.name, meta: formatBytes(file.size) }}
      heavyJob={{ bytes: file.size }}
      change={<ChangeFile label={t('tool.chooseAnotherFile')} onClick={reset} disabled={status.isProcessing} />}
      kind="form"
      bodyLabel={title}
      body={<FilePreview file={file.file} name={file.name} meta={formatBytes(file.size)} icon={<ShieldCheck aria-hidden size={18} />} />}
      side={form}
      // Kept: there is no recovery path for a lost PDF password. The password itself is never shown in a sentence.
      sentence={(
        <Sentence
          template="security-pdf.passwords.cannot.be.recovered.so.keep.yours.ce35f0"
          groupLabel={t('sentence.groupLabel', { tool: title })}
          disabled={status.isProcessing}
        />
      )}
      notice={notice}
      onRun={() => void handleProtect()}
      runDisabled={!canProtect || status.isProcessing}
      runDescribedBy={validationMessage ? validationId : undefined}
      runLabel={(
        <>
          <Lock aria-hidden size={18} />
          <span>{t("security-pdf.protect.with.password.b73965")}</span>
        </>
      )}
      progress={status.isProcessing ? (
        <ProgressLine label={status.message} percent={formatPercent(Math.max(0, Math.min(100, status.progress)))} value={status.progress} />
      ) : undefined}
    />
  );
};
