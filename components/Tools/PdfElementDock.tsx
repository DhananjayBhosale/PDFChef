import { t, formatNumber } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useState } from 'react';
import { Minus, MoreHorizontal, Palette, Plus, Trash2 } from 'lucide-react';
import type { EditorElement } from '../../services/pdfDocument';
import { keepCaret, SWATCHES } from './PdfParagraphInspector';

/**
 * A phone's controls for an added text box, picture or shape, in the paragraph dock's words.
 *
 * Found on a OnePlus 15: the old panel was a card with a second vocabulary (a native colour
 * picker, Helvetica / Times / Courier, typed numbers) and nothing at all above the keyboard while
 * a text box was being typed into. Now the row a typist reaches for stays above the keyboard, and
 * the rest comes back once it closes. Rotate and Page, rarely wanted, wait behind More.
 */

const FACES: Array<{ value: string; label: () => string }> = [
  { value: 'Helvetica', label: () => t('pdf-paragraph-inspector.sans.b3c181') },
  { value: 'TimesRoman', label: () => t('pdf-paragraph-inspector.serif.1b5e74') },
  { value: 'Courier', label: () => t('pdf-paragraph-inspector.mono.6f0015') },
];

interface Props {
  element: EditorElement;
  label: string;
  /** Rotate and Page, shown behind More. */
  more: React.ReactNode;
  onChange: (updates: Partial<EditorElement>) => void;
  onDelete: () => void;
  onDone: () => void;
}

export const PdfElementDock: React.FC<Props> = ({ element, label, more, onChange, onDelete, onDone }) => {
  useI18n();
  const [moreOpen, setMoreOpen] = useState(false);
  const isText = element.type === 'text';
  const isShape = element.type !== 'text' && element.type !== 'image';
  const colour = (element.color || (isText ? '#000000' : '#2563eb')).toLowerCase();
  const segment = 'chef-pressable chef-hit-y h-8 w-10 rounded-[calc(var(--radius-control)-2px)]';
  const quiet = 'text-[var(--text-secondary)]';
  const on = 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]';

  const stepper = (label: string, value: number, min: number, max: number, key: 'fontSize' | 'strokeWidth', less: string, more: string, icon?: React.ReactNode) => (
    <div role="group" aria-label={label} className="flex shrink-0 items-center">
      {icon}
      <button type="button" aria-label={less} onPointerDown={keepCaret} disabled={value <= min}
        onClick={() => onChange({ [key]: Math.max(min, value - 1) })} className={`${segment} grid place-items-center ${quiet} disabled:opacity-55`}>
        <Minus aria-hidden size={16} />
      </button>
      <span className="tabular min-w-[2.25rem] text-center text-xs font-bold text-[var(--text-primary)]">{formatNumber(value)}</span>
      <button type="button" aria-label={more} onPointerDown={keepCaret} disabled={value >= max}
        onClick={() => onChange({ [key]: Math.min(max, value + 1) })} className={`${segment} grid place-items-center ${quiet} disabled:opacity-55`}>
        <Plus aria-hidden size={16} />
      </button>
    </div>
  );

  const swatches = (
    <div role="group" aria-label={t('edit-pdf.colour.3a9dfa')} className="flex shrink-0 items-center gap-0.5">
      {SWATCHES.map((swatch) => (
        <button key={swatch.colour} type="button" aria-label={swatch.label} aria-pressed={colour === swatch.colour}
          onPointerDown={keepCaret} onClick={() => onChange({ color: swatch.colour })}
          className="chef-pressable chef-hit-y grid h-9 w-9 place-items-center rounded-full">
          <span aria-hidden style={{ backgroundColor: swatch.colour }}
            className={`h-6 w-6 rounded-full border border-[var(--border-strong)] ${colour === swatch.colour ? 'outline outline-2 outline-offset-2 outline-[var(--accent-rest)]' : ''}`} />
        </button>
      ))}
      <label className={`chef-pressable chef-hit-y relative grid h-9 w-9 place-items-center rounded-full ${quiet}`}>
        <Palette aria-hidden size={18} />
        <input type="color" aria-label={t('pdf-paragraph-inspector.colour.more')} value={colour}
          onChange={(event) => onChange({ color: event.target.value })}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
      </label>
    </div>
  );

  const deleteButton = (
    <button type="button" onClick={onDelete}
      className="chef-pressable chef-hit-y inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-xs font-bold text-[var(--status-danger-text)]">
      <Trash2 aria-hidden size={15} /><span>{t('edit-pdf.delete.3534d6').trim()}</span>
    </button>
  );
  const moreButton = (
    <button type="button" aria-label={t('edit-pdf.more.options')} aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}
      className={`chef-hide-while-typing ${segment} grid shrink-0 place-items-center ${moreOpen ? on : quiet}`}>
      <MoreHorizontal aria-hidden size={18} />
    </button>
  );
  const doneButton = (
    <button type="button" onClick={onDone}
      className="chef-pressable chef-hit-y inline-flex h-8 shrink-0 items-center rounded-[var(--radius-control)] px-3 text-sm font-bold text-[var(--accent-text)]">
      {t('pdf-paragraph-inspector.done.12e9a0').trim()}
    </button>
  );
  const filled = Boolean(element.fillColor && element.fillColor !== 'transparent');

  return (
    <section data-testid="pdf-element-dock" aria-label={label}
      className="chef-paragraph-dock mx-auto mb-2 max-w-md border-b border-[var(--border-hairline)] pb-1">
      {(isText || isShape) && (
        <div className="chef-hide-while-typing flex flex-wrap items-center gap-1.5 pb-1.5">
          {isText && (
            <div role="group" aria-label={t('pdf-paragraph-inspector.typeface.3a8c10')} className="flex shrink-0 items-center gap-0.5">
              {FACES.map((face) => (
                <button key={face.value} type="button" aria-pressed={(element.fontFamily || 'Helvetica') === face.value}
                  onClick={() => onChange({ fontFamily: face.value })}
                  className={`chef-pressable chef-hit-y h-9 rounded-[calc(var(--radius-control)-2px)] px-2.5 text-xs font-bold ${(element.fontFamily || 'Helvetica') === face.value ? on : quiet}`}>
                  {face.label()}
                </button>
              ))}
            </div>
          )}
          {isShape && swatches}
          <span className="flex-1" />
          {deleteButton}
        </div>
      )}
      {isText && <div className="chef-hide-while-typing flex items-center pb-1">{swatches}</div>}
      {moreOpen && <div className="chef-hide-while-typing flex flex-wrap items-end gap-2 pb-1.5">{more}</div>}
      <div className="flex min-h-11 flex-wrap items-center gap-x-1.5">
        {isText && (
          <>
            <div role="group" aria-label={t('pdf-paragraph-inspector.emphasis.0ab4b2')} className="flex shrink-0 items-center">
              <button type="button" aria-label={t('pdf-paragraph-inspector.bold.94fee6')} aria-pressed={(element.fontWeight ?? 400) >= 600}
                onPointerDown={keepCaret} onClick={() => onChange({ fontWeight: (element.fontWeight ?? 400) >= 600 ? 400 : 700 })}
                className={`${segment} text-sm font-black ${(element.fontWeight ?? 400) >= 600 ? on : quiet}`}>{t('pdf-paragraph-inspector.b.df7e70')}</button>
              <button type="button" aria-label={t('pdf-paragraph-inspector.italic.9bf37c')} aria-pressed={element.fontStyle === 'italic'}
                onPointerDown={keepCaret} onClick={() => onChange({ fontStyle: element.fontStyle === 'italic' ? 'normal' : 'italic' })}
                className={`${segment} font-serif text-sm italic ${element.fontStyle === 'italic' ? on : quiet}`}>{t('pdf-paragraph-inspector.i.a83dd0')}</button>
            </div>
            {stepper(t('pdf-paragraph-inspector.text.size.d68761'), element.fontSize || 16, 8, 72, 'fontSize',
              t('pdf-paragraph-inspector.decrease.text.size.e63b95'), t('pdf-paragraph-inspector.increase.text.size.4b1980'))}
          </>
        )}
        {isShape && (
          <>
            {(element.type === 'rectangle' || element.type === 'ellipse') && (
              <button type="button" aria-pressed={filled}
                onClick={() => onChange({ fillColor: filled ? 'transparent' : '#93c5fd' })}
                className={`chef-pressable chef-hit-y h-8 shrink-0 rounded-[calc(var(--radius-control)-2px)] px-2.5 text-xs font-bold ${filled ? on : quiet}`}>
                {t('edit-pdf.fill.033955')}
              </button>
            )}
            {stepper(t('edit-pdf.stroke.1582a1'), element.strokeWidth || 2, 1, 16, 'strokeWidth',
              t('edit-pdf.stroke.thinner'), t('edit-pdf.stroke.thicker'),
              // Line weight, so the stepper does not read as part of Fill.
              <svg aria-hidden width="18" height="16" viewBox="0 0 18 16" className="ml-1.5 mr-0.5 shrink-0 text-[var(--text-secondary)]">
                <path d="M2 3.5h14" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                <path d="M2 8h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M2 13h14" stroke="currentColor" strokeWidth="3.25" strokeLinecap="round" />
              </svg>)}
          </>
        )}
        {element.type === 'image' && deleteButton}
        <span className="flex-1" />
        {moreButton}
        {doneButton}
      </div>
    </section>
  );
};
