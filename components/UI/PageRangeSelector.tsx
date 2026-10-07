import React, { useEffect, useId, useRef, useState } from 'react';
import { t } from '../../services/i18n/core.ts';
import { localizeError } from '../../services/i18n/errors.ts';
import { useI18n } from '../../services/i18n/react';
import { parseBoundedPageRange } from '../../services/pageRange';
import { Button } from './Primitives';

interface PageRangeSelectorProps {
  totalPages: number;
  disabled?: boolean;
  onApply: (pages: number[]) => void;
  onPendingChange: (pending: boolean) => void;
}

/** A typed range replaces the selection only after Select or Enter. */
export const PageRangeSelector: React.FC<PageRangeSelectorProps> = ({
  totalPages, disabled = false, onApply, onPendingChange,
}) => {
  useI18n();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const reportedPendingRef = useRef(false);
  const [draft, setDraft] = useState('');
  const [applied, setApplied] = useState('');
  const [error, setError] = useState('');
  const pending = Boolean(draft.trim() && draft.trim() !== applied);
  const unavailable = disabled || totalPages < 1;
  const hint = t('page-range-selector.hint').split(/(187-230|1,5,10-20)/);

  useEffect(() => { onPendingChange(reportedPendingRef.current); }, [onPendingChange]);

  const reportPending = (next: boolean) => {
    if (next === reportedPendingRef.current) return;
    reportedPendingRef.current = next;
    onPendingChange(next);
  };

  const select = (event: React.FormEvent) => {
    event.preventDefault();
    if (unavailable || !draft.trim() || composingRef.current) return;
    try {
      const pages = parseBoundedPageRange(draft, totalPages);
      onApply(pages);
      setApplied(draft.trim());
      setError('');
      reportPending(false);
      inputRef.current?.blur();
    } catch (cause) {
      setError(localizeError(cause));
    }
  };

  return (
    <form noValidate onSubmit={select} className="flex min-w-0 flex-col gap-1.5" data-page-range-selector>
      <div className="flex min-w-0 items-end gap-2">
        <label htmlFor={id} className="min-w-0 flex-1 text-sm font-semibold text-[var(--text-secondary)]">
          {t('page-range-selector.label')}
          <input
            ref={inputRef}
            id={id}
            dir="ltr"
            type="text"
            inputMode="text"
            enterKeyHint="done"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={512}
            value={draft}
            placeholder={t('page-range-selector.example')}
            disabled={unavailable}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={`${id}-hint${pending ? ` ${id}-pending` : ''}${error ? ` ${id}-error` : ''}`}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
            }}
            onChange={(event) => {
              const next = event.target.value;
              setDraft(next);
              setError('');
              // Lock/unlock exports in the same input event, before another action can run.
              reportPending(Boolean(next.trim() && next.trim() !== applied));
            }}
            className="chef-field chef-target mt-1 w-full min-w-0 px-3 text-base font-normal disabled:opacity-55"
          />
        </label>
        <Button type="submit" tone="secondary" disabled={unavailable || !draft.trim()} className="shrink-0 px-3">
          {t('page-range-selector.select')}
        </Button>
      </div>
      <p id={`${id}-hint`} className="type-caption text-[var(--text-secondary)]">
        {hint.map((text, index) => text === '187-230' || text === '1,5,10-20'
          ? <bdi key={index} dir="ltr" className="whitespace-nowrap">{text}</bdi>
          : text)}
      </p>
      <p id={`${id}-pending`} role="status" aria-atomic="true" className={`type-footnote text-[var(--accent-text)]${pending ? '' : ' sr-only'}`}>
        {pending ? t('page-range-selector.pending') : ''}
      </p>
      {error && <p id={`${id}-error`} role="alert" className="type-footnote text-[var(--status-danger-text)]">{error}</p>}
    </form>
  );
};
