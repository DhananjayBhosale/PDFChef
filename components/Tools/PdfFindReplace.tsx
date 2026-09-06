import React, { useEffect, useRef } from 'react';
import { ArrowDown, ArrowUp, CaseSensitive, Replace, X } from 'lucide-react';

/**
 * Find and replace across the document's paragraphs.
 *
 * The bar deliberately stays one row on a phone and reveals the replace row only when asked, so
 * the page it is searching does not disappear behind its own controls. Navigation puts the
 * platform's own selection on the match rather than drawing a highlight, which means the match is
 * already selected and ready to type over.
 */

interface Props {
  query: string;
  replacement: string;
  caseSensitive: boolean;
  matchCount: number;
  activeMatch: number;
  scanning: boolean;
  showReplace: boolean;
  compact: boolean;
  onQueryChange: (value: string) => void;
  onReplacementChange: (value: string) => void;
  onCaseSensitiveChange: (value: boolean) => void;
  onShowReplaceChange: (value: boolean) => void;
  onStep: (delta: number) => void;
  onReplaceOne: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}

export const PdfFindReplace: React.FC<Props> = ({
  query,
  replacement,
  caseSensitive,
  matchCount,
  activeMatch,
  scanning,
  showReplace,
  compact,
  onQueryChange,
  onReplacementChange,
  onCaseSensitiveChange,
  onShowReplaceChange,
  onStep,
  onReplaceOne,
  onReplaceAll,
  onClose,
}) => {
  const queryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    queryRef.current?.focus();
  }, []);

  const fieldClass = 'h-11 min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-rest)]';
  const iconClass = 'chef-pressable chef-target grid shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] disabled:opacity-45';

  return (
    <section
      data-testid="pdf-find-replace"
      aria-label="Find and replace"
      className={`rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-2 shadow-lg ${compact ? 'mx-auto mb-2 max-w-md' : 'mb-2'}`}
    >
      {/* On a phone the query field and the controls each get their own row: six touch targets and
          a text field do not fit across 390px without squeezing the field down to nothing. */}
      <div className={compact ? 'flex flex-col gap-1.5' : 'flex items-center gap-1.5'}>
        <div className="flex items-center gap-1.5">
        <input
          ref={queryRef}
          type="search"
          value={query}
          aria-label="Find in this PDF"
          placeholder="Find in this PDF"
          enterKeyHint="search"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onStep(event.shiftKey ? -1 : 1);
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
          className={fieldClass}
        />
        {compact && (
          <button type="button" aria-label="Close find" onClick={onClose} className={iconClass}><X aria-hidden size={19} /></button>
        )}
        </div>
        <div className="flex items-center gap-1.5">
        <span
          aria-live="polite"
          data-testid="pdf-find-count"
          className="tabular shrink-0 px-1 text-xs font-semibold text-[var(--text-secondary)]"
        >
          {scanning ? 'Searching…' : query ? (matchCount > 0 ? `${activeMatch + 1} of ${matchCount}` : 'None') : ''}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Match case"
          aria-pressed={caseSensitive}
          onClick={() => onCaseSensitiveChange(!caseSensitive)}
          className={`${iconClass} ${caseSensitive ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : ''}`}
        ><CaseSensitive aria-hidden size={19} /></button>
        <button type="button" aria-label="Previous match" disabled={matchCount === 0} onClick={() => onStep(-1)} className={iconClass}><ArrowUp aria-hidden size={19} /></button>
        <button type="button" aria-label="Next match" disabled={matchCount === 0} onClick={() => onStep(1)} className={iconClass}><ArrowDown aria-hidden size={19} /></button>
        <button
          type="button"
          aria-label="Replace"
          aria-pressed={showReplace}
          aria-expanded={showReplace}
          onClick={() => onShowReplaceChange(!showReplace)}
          className={`${iconClass} ${showReplace ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : ''}`}
        ><Replace aria-hidden size={19} /></button>
        {!compact && (
          <button type="button" aria-label="Close find" onClick={onClose} className={iconClass}><X aria-hidden size={19} /></button>
        )}
        </div>
      </div>

      {showReplace && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            type="text"
            value={replacement}
            aria-label="Replace with"
            placeholder="Replace with"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => onReplacementChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onReplaceOne();
              }
            }}
            className={fieldClass}
          />
          <button
            type="button"
            disabled={matchCount === 0}
            onClick={onReplaceOne}
            className="chef-pressable chef-hit-y h-11 shrink-0 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 text-xs font-bold text-[var(--text-primary)] disabled:opacity-45"
          >Replace</button>
          <button
            type="button"
            disabled={matchCount === 0}
            onClick={onReplaceAll}
            className="chef-pressable chef-hit-y h-11 shrink-0 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-3 text-xs font-bold text-[var(--text-on-accent)] disabled:opacity-45"
          >All</button>
        </div>
      )}
    </section>
  );
};
