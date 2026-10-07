import { t, formatNumber } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
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
  { value: 'original', get label() { return t("pdf-paragraph-inspector.original.88d759"); } },
  { value: 'sans-serif', get label() { return t("pdf-paragraph-inspector.sans.b3c181"); } },
  { value: 'serif', get label() { return t("pdf-paragraph-inspector.serif.1b5e74"); } },
  { value: 'monospace', get label() { return t("pdf-paragraph-inspector.mono.6f0015"); } },
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
}: Props) => {
  useI18n();
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
    ? t("pdf-paragraph-inspector.drawn.with.8725d6", { v0: descriptor ? prettyFontName(descriptor) : t("pdf-paragraph-inspector.the.document.s.own.font.a9ae3e") })
    : t("pdf-paragraph-inspector.substituted.da7416", { v0: t(`font.class.${font?.klass ?? 'sans-serif'}`), v1: font?.reason ? ` — ${font.reason}` : '' });

  const outcome = !plan || plan.mode === 'unchanged'
    ? t("pdf-paragraph-inspector.no.changes.yet.9b1d0a")
    : plan.mode === 'direct'
      // Plain words on purpose. Someone correcting a name on a form is told what will happen to
      // their document, not how a PDF is built: "text object" and "render" are our vocabulary, and
      // a reader who meets them here has been handed our problem instead of an answer.
      ? t("pdf-paragraph-inspector.your.change.goes.straight.into.the.document.8766f9")
      : plan.mode === 'blocked'
      // The reason is left out on purpose: it names a font encoding or a text object, which is not
      // something a reader can do anything about. The one thing they can do is on the end.
      ? t("pdf-paragraph-inspector.this.paragraph.cannot.be.changed.add.a.76c083")
      : t("pdf-paragraph-inspector.this.paragraph.will.be.redrawn.with.a.519080", { v0: overrun > 0
          ? t("pdf-paragraph-inspector.it.is.now.taller.than.the.space.deecb0")
          : '' });

  const stepFontSize = (delta: number) => onUpdate({
    fontSize: Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round((fontSize + delta) * 10) / 10)),
  });

  const typefaceGroup = compact ? (
    <label className="flex h-10 shrink-0 items-center rounded-[var(--radius-control)] border border-[var(--border-strong)] px-2">
      <span className="sr-only">{t("pdf-paragraph-inspector.typeface.3a8c10")}</span>
      <select
        aria-label={t("pdf-paragraph-inspector.typeface.3a8c10")}
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
      aria-label={t("pdf-paragraph-inspector.typeface.3a8c10")}
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
    <div role="group" aria-label={t("pdf-paragraph-inspector.emphasis.0ab4b2")} className="flex shrink-0 items-center gap-0.5 rounded-[var(--radius-control)] border border-[var(--border-strong)] p-0.5">
      <button
        type="button"
        aria-label={t("pdf-paragraph-inspector.bold.94fee6")}
        aria-pressed={bold}
        onClick={() => {
          const next = !bold;
          setOverride({ bold: next === (descriptor?.bold ?? false) ? null : next });
        }}
        className={`chef-pressable chef-hit-y h-9 w-9 rounded-[calc(var(--radius-control)-2px)] text-sm font-black ${bold ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : 'text-[var(--text-secondary)]'}`}
      >{t("pdf-paragraph-inspector.b.df7e70")}</button>
      <button
        type="button"
        aria-label={t("pdf-paragraph-inspector.italic.9bf37c")}
        aria-pressed={italic}
        onClick={() => {
          const next = !italic;
          setOverride({ italic: next === (descriptor?.italic ?? false) ? null : next });
        }}
        className={`chef-pressable chef-hit-y h-9 w-9 rounded-[calc(var(--radius-control)-2px)] font-serif text-sm italic ${italic ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : 'text-[var(--text-secondary)]'}`}
      >{t("pdf-paragraph-inspector.i.a83dd0")}</button>
    </div>
  );

  const sizeGroup = (
    <div role="group" aria-label={t("pdf-paragraph-inspector.text.size.d68761")} className="flex shrink-0 items-center gap-0.5 rounded-[var(--radius-control)] border border-[var(--border-strong)] p-0.5">
      <button
        type="button"
        aria-label={t("pdf-paragraph-inspector.decrease.text.size.e63b95")}
        onClick={() => stepFontSize(-0.5)}
        className="chef-pressable chef-hit-y grid h-9 w-9 place-items-center rounded-[calc(var(--radius-control)-2px)] text-[var(--text-secondary)]"
      ><Minus aria-hidden size={16} /></button>
      <span className="tabular min-w-[2.75rem] text-center text-xs font-bold text-[var(--text-primary)]">
        {formatNumber(fontSize, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
      </span>
      <button
        type="button"
        aria-label={t("pdf-paragraph-inspector.increase.text.size.4b1980")}
        onClick={() => stepFontSize(0.5)}
        className="chef-pressable chef-hit-y grid h-9 w-9 place-items-center rounded-[calc(var(--radius-control)-2px)] text-[var(--text-secondary)]"
      ><Plus aria-hidden size={16} /></button>
    </div>
  );

  const colourField = (
    <label className="flex shrink-0 items-center">
      <span className="sr-only">{t("pdf-paragraph-inspector.text.colour.25e9c8")}</span>
      <input
        type="color"
        aria-label={t("pdf-paragraph-inspector.text.colour.25e9c8")}
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
      aria-label={t("pdf-paragraph-inspector.revert.this.paragraph.6e2d05")}
      className="chef-pressable chef-hit-y inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-xs font-bold text-[var(--text-secondary)]"
    ><RotateCcw aria-hidden size={15} /><span className={compact ? 'sr-only' : undefined}>{t("pdf-paragraph-inspector.revert.0026c5")}</span></button>
  ) : null;

  const doneButton = (
    <button
      type="button"
      onClick={onDone}
      className="chef-pressable chef-hit-y inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-3 text-xs font-bold text-[var(--text-on-accent)]"
    ><Check aria-hidden size={15} />{t("pdf-paragraph-inspector.done.12e9a0")}</button>
  );

  return (
    <section
      data-testid="pdf-paragraph-inspector"
      aria-label={t("pdf-paragraph-inspector.paragraph.formatting.b29313")}
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
            <span className="text-xs font-semibold text-[var(--text-secondary)]">{t("pdf-paragraph-inspector.pt.e75b11")}</span>
            <span className="flex-1" />
            {revertButton}
            {doneButton}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {typefaceGroup}
          {emphasisGroup}
          {sizeGroup}
          <span className="text-xs font-semibold text-[var(--text-secondary)]">{t("pdf-paragraph-inspector.pt.e75b11")}</span>
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
        {plan?.mode === 'blocked' ? outcome : t("pdf-paragraph-inspector..b8832c", { v0: provenance, v1: outcome })}
      </p>
    </section>
  );
};
