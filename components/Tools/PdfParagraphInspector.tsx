import React from 'react';
import { Check, Minus, Plus, RotateCcw } from 'lucide-react';
import type { PdfTextBlock } from '../../services/pdfTextBlocks';
import type { BlockEditPlan } from '../../services/pdfBlockEditPlanning';
import {
  prettyFontName,
  type FontClass,
  type PdfFontDescriptor,
  type ResolvedFont,
} from '../../services/pdfFontResolution';
import type { BlockEditState } from './PdfTextBlockLayer';

/**
 * Controls for the paragraph that currently has the caret.
 *
 * Two things here are deliberate. The typeface control offers "Original" as a real, selected
 * option rather than a blank, so a paragraph is never silently restyled. And the panel always
 * states what the save will do to this paragraph — rewrite the PDF's own text objects, or repaint
 * and redraw it — because those two outcomes look identical on screen but are not the same file.
 */

interface Props {
  block: PdfTextBlock;
  edit: BlockEditState | undefined;
  descriptor: PdfFontDescriptor | undefined;
  font: ResolvedFont | null;
  plan: BlockEditPlan | null;
  /** How far a redrawn paragraph would spill past the space it had, in points. 0 when it fits. */
  overrun?: number;
  compact: boolean;
  onUpdate: (updates: Partial<BlockEditState>) => void;
  onRevert: () => void;
  onDone: () => void;
}

const TYPEFACES: Array<{ value: FontClass | 'original'; label: string }> = [
  { value: 'original', label: 'Original' },
  { value: 'sans-serif', label: 'Sans' },
  { value: 'serif', label: 'Serif' },
  { value: 'monospace', label: 'Mono' },
];

const MIN_FONT_SIZE = 4;
const MAX_FONT_SIZE = 96;

export const PdfParagraphInspector: React.FC<Props> = ({
  block,
  edit,
  descriptor,
  font,
  plan,
  overrun = 0,
  compact,
  onUpdate,
  onRevert,
  onDone,
}) => {
  const isDirty = Boolean(edit) && (
    edit!.text !== block.text
    || edit!.fontOverride !== undefined
    || edit!.fontSize !== undefined
    || edit!.color !== undefined
  );
  const fontSize = edit?.fontSize ?? block.fontSize;
  const activeTypeface = edit?.fontOverride?.klass ?? 'original';
  const bold = edit?.fontOverride?.bold ?? descriptor?.bold ?? false;
  const italic = edit?.fontOverride?.italic ?? descriptor?.italic ?? false;

  const setOverride = (updates: Partial<NonNullable<BlockEditState['fontOverride']>>) =>
    onUpdate({ fontOverride: { ...edit?.fontOverride, ...updates } });

  const provenance = font?.mode === 'embedded'
    ? `Drawn with ${descriptor ? prettyFontName(descriptor) : 'the document’s own font'}`
    : `Substituted ${font?.klass ?? 'sans-serif'}${font?.reason ? ` — ${font.reason}` : ''}`;

  const outcome = !plan || plan.mode === 'unchanged'
    ? 'No changes yet.'
    : plan.mode === 'direct'
      // Plain words on purpose. Someone correcting a name on a form is told what will happen to
      // their document, not how a PDF is built: "text object" and "render" are our vocabulary, and
      // a reader who meets them here has been handed our problem instead of an answer.
      ? 'Your change goes straight into the document. It keeps this typeface, and nothing is covered over.'
      : plan.mode === 'blocked'
      // The reason is left out on purpose: it names a font encoding or a text object, which is not
      // something a reader can do anything about. The one thing they can do is on the end.
      ? 'This paragraph cannot be changed. Add a text box over it instead.'
      : `This paragraph will be redrawn rather than typed over, so its lettering may sit a little differently. Finish editing to preview how it will be saved.${
        overrun > 0
          ? ' It is now taller than the space it had, and what follows will not move down — shorten it, or make the text smaller, so the two do not overlap.'
          : ''
      }`;

  const stepFontSize = (delta: number) => onUpdate({
    fontSize: Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round((fontSize + delta) * 10) / 10)),
  });

  const typefaceGroup = compact ? (
    <label className="flex h-10 shrink-0 items-center rounded-[var(--radius-control)] border border-[var(--border-strong)] px-2">
      <span className="sr-only">Typeface</span>
      <select
        aria-label="Typeface"
        value={activeTypeface}
        onChange={(event) => setOverride({
          klass: event.currentTarget.value === 'original' ? null : event.currentTarget.value as FontClass,
        })}
        className="h-9 bg-transparent text-xs font-bold text-[var(--text-primary)] outline-none"
      >
        {TYPEFACES.map((typeface) => (
          <option key={typeface.value} value={typeface.value}>{typeface.label}</option>
        ))}
      </select>
    </label>
  ) : (
    <div
      role="group"
      aria-label="Typeface"
      className="flex shrink-0 items-center gap-0.5 rounded-[var(--radius-control)] border border-[var(--border-strong)] p-0.5"
    >
      {TYPEFACES.map((typeface) => (
        <button
          key={typeface.value}
          type="button"
          aria-pressed={activeTypeface === typeface.value}
          onClick={() => setOverride({ klass: typeface.value === 'original' ? null : typeface.value })}
          className={`chef-pressable chef-hit-y h-9 rounded-[calc(var(--radius-control)-2px)] px-2.5 text-xs font-bold ${
            activeTypeface === typeface.value
              ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]'
              : 'text-[var(--text-secondary)]'
          }`}
        >
          {typeface.label}
        </button>
      ))}
    </div>
  );

  const emphasisGroup = (
    <div role="group" aria-label="Emphasis" className="flex shrink-0 items-center gap-0.5 rounded-[var(--radius-control)] border border-[var(--border-strong)] p-0.5">
      <button
        type="button"
        aria-label="Bold"
        aria-pressed={bold}
        onClick={() => setOverride({ bold: !bold })}
        className={`chef-pressable chef-hit-y h-9 w-9 rounded-[calc(var(--radius-control)-2px)] text-sm font-black ${bold ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : 'text-[var(--text-secondary)]'}`}
      >B</button>
      <button
        type="button"
        aria-label="Italic"
        aria-pressed={italic}
        onClick={() => setOverride({ italic: !italic })}
        className={`chef-pressable chef-hit-y h-9 w-9 rounded-[calc(var(--radius-control)-2px)] font-serif text-sm italic ${italic ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : 'text-[var(--text-secondary)]'}`}
      >I</button>
    </div>
  );

  const sizeGroup = (
    <div role="group" aria-label="Text size" className="flex shrink-0 items-center gap-0.5 rounded-[var(--radius-control)] border border-[var(--border-strong)] p-0.5">
      <button
        type="button"
        aria-label="Decrease text size"
        onClick={() => stepFontSize(-0.5)}
        className="chef-pressable chef-hit-y grid h-9 w-9 place-items-center rounded-[calc(var(--radius-control)-2px)] text-[var(--text-secondary)]"
      ><Minus aria-hidden size={16} /></button>
      <span className="tabular min-w-[2.75rem] text-center text-xs font-bold text-[var(--text-primary)]">
        {fontSize.toFixed(1)}
      </span>
      <button
        type="button"
        aria-label="Increase text size"
        onClick={() => stepFontSize(0.5)}
        className="chef-pressable chef-hit-y grid h-9 w-9 place-items-center rounded-[calc(var(--radius-control)-2px)] text-[var(--text-secondary)]"
      ><Plus aria-hidden size={16} /></button>
    </div>
  );

  const colourField = (
    <label className="flex shrink-0 items-center">
      <span className="sr-only">Text colour</span>
      <input
        type="color"
        aria-label="Text colour"
        value={edit?.color ?? '#000000'}
        onChange={(event) => onUpdate({ color: event.target.value })}
        className="chef-hit-y h-9 w-11 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-transparent p-1"
      />
    </label>
  );

  const revertButton = isDirty ? (
    <button
      type="button"
      onClick={onRevert}
      aria-label="Revert this paragraph"
      className="chef-pressable chef-hit-y inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-xs font-bold text-[var(--text-secondary)]"
    ><RotateCcw aria-hidden size={15} /><span className={compact ? 'sr-only' : undefined}>Revert</span></button>
  ) : null;

  const doneButton = (
    <button
      type="button"
      onClick={onDone}
      className="chef-pressable chef-hit-y inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-3 text-xs font-bold text-[var(--text-on-accent)]"
    ><Check aria-hidden size={15} /> Done</button>
  );

  return (
    <section
      data-testid="pdf-paragraph-inspector"
      aria-label="Paragraph formatting"
      className={`mx-auto rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] shadow-lg ${compact ? 'mb-2 max-w-md p-2' : 'w-full p-3'}`}
    >
      {/* A phone gets two rows rather than one that scrolls sideways: every control has to be
          reachable without discovering that the strip moves, which a hidden scrollbar never tells
          anyone. A wide screen fits them all on one line. */}
      {compact ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            {typefaceGroup}
            {emphasisGroup}
            {colourField}
          </div>
          <div className="flex items-center gap-1.5">
            {sizeGroup}
            <span className="text-xs font-semibold text-[var(--text-secondary)]">pt</span>
            <span className="flex-1" />
            {revertButton}
            {doneButton}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {typefaceGroup}
          {emphasisGroup}
          {sizeGroup}
          <span className="text-xs font-semibold text-[var(--text-secondary)]">pt</span>
          {colourField}
          <span className="flex-1" />
          {revertButton}
          {doneButton}
        </div>
      )}

      {/* This sentence is the answer to "what will saving do to my document", so it is set at the
          body size rather than the smallest one available. It was the only text in the editor
          below the type scale, and the one a reader most needs to be able to read. */}
      <p data-testid="pdf-paragraph-provenance" className="mt-1 px-0.5 text-sm font-medium leading-snug text-[var(--text-secondary)]">
        {/* Which typeface is drawing the paragraph is worth knowing while it can still be changed.
            Once the answer is no it is only noise in front of the one sentence that matters. */}
        {plan?.mode === 'blocked' ? outcome : `${provenance}. ${outcome}`}
      </p>
    </section>
  );
};
