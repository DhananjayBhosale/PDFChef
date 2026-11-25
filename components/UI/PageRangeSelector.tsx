import React, { useEffect, useId, useRef, useState } from 'react';
import { t } from '../../services/i18n/core.ts';
import { localizeError } from '../../services/i18n/errors.ts';
import { useI18n } from '../../services/i18n/react';
import { parseBoundedPageRange } from '../../services/pageRange';
import { Button, cx } from './Primitives';
import { useCloseEditor } from '../Tool/Popover';

interface PageRangeSelectorProps {
  totalPages: number;
  disabled?: boolean;
  onApply: (pages: number[]) => void;
  onPendingChange: (pending: boolean) => void;
  /** Keeps the label as the field's name but hides it visually (a slot's editor title shows it). */
  hideLabel?: boolean;
  /** Compact (at rest beside the sentence): field and Select on one row, the hint as the field's description only. */
  compact?: boolean;
  /** The field, for a slot that focuses it. */
  inputRef?: React.Ref<HTMLInputElement>;
  /** The typed text, so a slot can show what was typed (an invalid entry in the error tone). */
  onDraftChange?: (draft: string, invalid: boolean) => void;
  /**
   * A typed range that is valid is used as it is typed, so the main action needs no Select first
   * (Extract, research r2 H2-02). Select and Enter still apply it and close an editor; an
   * unfinished entry ("1-") stays pending.
   */
  live?: boolean;
  className?: string;
}

/**
 * The examples in today's strings ("187-230", "1,5,10-20") fitted to the open file, so a 3-page PDF
 * is not shown pages it does not have (polish item 12). A file that has those pages keeps them.
 */
const RANGE_EXAMPLE = '187-230';
const LIST_EXAMPLE = '1,5,10-20';
const rangeExample = (total: number) => (total < 1 || total >= 230 ? RANGE_EXAMPLE : total === 1 ? '1' : `${Math.min(2, total - 1)}-${total}`);
const listExample = (total: number) => (total < 1 || total >= 20 ? LIST_EXAMPLE : total >= 4 ? `1,3-${total}` : total === 3 ? '1,3' : total === 2 ? '1,2' : '1');
/** Left-to-right isolate: after an Arabic word, "2-3" would otherwise show as "3-2". */
const ltr = (text: string) => `\u2066${text}\u2069`;

/** The range field's placeholder ("e.g. 2-3"), fitted to the file; Delete Pages uses it too (T-15). */
export const rangePlaceholder = (totalPages: number) => t('page-range-selector.example').replace(RANGE_EXAMPLE, ltr(rangeExample(totalPages)));

/** A typed range replaces the selection after Select or Enter, or as it is typed with `live`. */
export const PageRangeSelector: React.FC<PageRangeSelectorProps> = ({
  totalPages, disabled = false, onApply, onPendingChange, hideLabel = false, compact = false, inputRef: outerRef, onDraftChange, live = false, className,
}) => {
  useI18n();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const closeEditor = useCloseEditor();
  const setInput = (node: HTMLInputElement | null) => {
    inputRef.current = node;
    if (typeof outerRef === 'function') outerRef(node);
    else if (outerRef) (outerRef as React.MutableRefObject<HTMLInputElement | null>).current = node;
  };
  const composingRef = useRef(false);
  const reportedPendingRef = useRef(false);
  const [draft, setDraft] = useState('');
  const [applied, setApplied] = useState('');
  const [error, setError] = useState('');
  const pending = Boolean(draft.trim() && draft.trim() !== applied);
  // A rejected range says what is wrong, not "Press Select" as well (fix round 2, item 10:
  // desktop-r9-04, where a screen reader heard both).
  const pendingLine = pending && !error;
  const unavailable = disabled || totalPages < 1;
  const hint = t('page-range-selector.hint').split(/(187-230|1,5,10-20)/);
  const example = rangePlaceholder(totalPages);

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
      onDraftChange?.(draft.trim(), false);
      // In a slot's editor: close it, so the result and the main action are in view
      // and focus is back on the slot. On the page: leave the field.
      if (closeEditor) closeEditor();
      else inputRef.current?.blur();
    } catch (cause) {
      setError(localizeError(cause));
      onDraftChange?.(draft.trim(), true);
    }
  };

  return (
    <form noValidate onSubmit={select} className={cx('flex min-w-0 flex-col gap-1.5', compact && 'tk-range-inline', className)} data-page-range-selector data-compact={compact ? '' : undefined}>
      <div className="flex min-w-0 items-end gap-2">
        <label htmlFor={id} className="min-w-0 flex-1 text-sm font-semibold text-[var(--text-secondary)]">
          {hideLabel ? <span className="sr-only">{t('page-range-selector.label')}</span> : t('page-range-selector.label')}
          <input
            ref={setInput}
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
            placeholder={example}
            disabled={unavailable}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={`${id}-hint${pendingLine ? ` ${id}-pending` : ''}${error ? ` ${id}-error` : ''}`}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
            }}
            onChange={(event) => {
              const next = event.target.value;
              setDraft(next);
              setError('');
              onDraftChange?.(next.trim(), false);
              if (live && next.trim() && !unavailable && !composingRef.current) {
                let pages: number[] | null = null;
                try { pages = parseBoundedPageRange(next, totalPages); } catch { /* Not finished yet: pending until it reads as pages. */ }
                if (pages) {
                  onApply(pages);
                  setApplied(next.trim());
                  reportPending(false);
                  return;
                }
              }
              // Lock/unlock exports in the same input event, before another action can run.
              reportPending(Boolean(next.trim() && next.trim() !== applied));
            }}
            className={cx('chef-field chef-target w-full min-w-0 px-3 text-base font-normal disabled:opacity-55', !hideLabel && 'mt-1')}
          />
        </label>
        <Button type="submit" tone="secondary" disabled={unavailable || !draft.trim()} className="shrink-0 px-3">
          {t('page-range-selector.select')}
        </Button>
      </div>
      <p id={`${id}-hint`} className={compact ? 'sr-only' : 'type-caption text-[var(--text-secondary)]'}>
        {hint.map((text, index) => text === RANGE_EXAMPLE || text === LIST_EXAMPLE
          ? <bdi key={index} dir="ltr" className="whitespace-nowrap">{text === RANGE_EXAMPLE ? rangeExample(totalPages) : listExample(totalPages)}</bdi>
          : text)}
      </p>
      {/* Compact (at rest beside the sentence): the tool's notice line shows the pending line, so this one is spoken only. */}
      <p id={`${id}-pending`} role="status" aria-atomic="true" className={`type-footnote text-[var(--accent-text)]${pendingLine && !compact ? '' : ' sr-only'}`}>
        {pendingLine ? t('page-range-selector.pending.select') : ''}
      </p>
      {error && <p id={`${id}-error`} role="alert" className="type-footnote text-[var(--status-danger-text)]">{error}</p>}
    </form>
  );
};
