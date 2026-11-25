import { t, formatNumber } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, Info, Minus, Palette, Plus, RotateCcw } from 'lucide-react';
import type { PdfTextBlock } from '../../services/pdfTextBlocks';
import type { BlockEditPlan } from '../../services/pdfBlockEditPlanning';
import {
  prettyFontName,
  type FontClass,
  type PdfFontDescriptor,
  type ResolvedFont,
} from '../../services/pdfFontResolution';
import { hasParagraphRestyle, type BlockEditState } from './PdfTextBlockLayer';

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
  /** A line now runs past the width the paragraph had. */
  overflowsWidth?: boolean;
  /** The colour the page draws the paragraph in, shown until one is picked. */
  ink?: string;
  compact: boolean;
  /** On a phone, the field the paragraph is typed into, shown above B, I and size. */
  field?: React.ReactNode;
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

export const SWATCHES: Array<{ colour: string; label: string }> = [
  { colour: '#000000', get label() { return t("pdf-paragraph-inspector.colour.black"); } },
  { colour: '#c62828', get label() { return t("pdf-paragraph-inspector.colour.red"); } },
  { colour: '#1565c0', get label() { return t("pdf-paragraph-inspector.colour.blue"); } },
  { colour: '#2e7d32', get label() { return t("pdf-paragraph-inspector.colour.green"); } },
];

const MIN_FONT_SIZE = 4;

/**
 * Keeps the caret, and the keyboard, in the paragraph while a formatting button is pressed.
 * A finger with the keyboard closed lets the button take focus instead: Android opens the
 * keyboard again on any tap while the paragraph keeps focus, which hides the colours and
 * typefaces just as they are being tried.
 */
export const keepCaret = (event: React.PointerEvent) => {
  if (event.pointerType === 'mouse' || document.documentElement.hasAttribute('data-chef-keyboard')) {
    event.preventDefault();
  }
};
const MAX_FONT_SIZE = 96;

export const PdfParagraphInspector: React.FC<Props> = ({
  block,
  edit,
  descriptor,
  font,
  plan,
  overrun = 0,
  overflowsWidth = false,
  ink,
  compact,
  field,
  onUpdate,
  onRevert,
  onDone,
}: Props) => {
  useI18n();
  const isDirty = Boolean(edit) && (edit!.text !== block.text || hasParagraphRestyle(edit, ink));
  const fontSize = edit?.fontSize ?? block.fontSize;
  const activeTypeface = edit?.fontOverride?.klass ?? 'original';
  const bold = edit?.fontOverride?.bold ?? descriptor?.bold ?? false;
  const italic = edit?.fontOverride?.italic ?? descriptor?.italic ?? false;

  const setOverride = (updates: Partial<NonNullable<BlockEditState['fontOverride']>>) =>
    onUpdate({ fontOverride: { ...edit?.fontOverride, ...updates } });

  const provenance = font?.mode === 'embedded'
    ? t("pdf-paragraph-inspector.drawn.with.8725d6", { v0: descriptor ? prettyFontName(descriptor) : t("pdf-paragraph-inspector.the.document.s.own.font.a9ae3e") })
    // The resolver's reason ("font is missing glyphs for q") is diagnostic English, not something a
    // reader can act on, so it stays out of the copy.
    : t("pdf-paragraph-inspector.substituted.da7416", { v0: t(`font.class.${font?.klass ?? 'sans-serif'}`), v1: '' });

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

  // One short line says what saving will do, so the page keeps the room. The full account is a
  // tap away. The most pressing fact wins the line: a paragraph that cannot be saved, then one
  // that will collide with what follows, then a font that is about to change. Nothing is said
  // until something has changed: found on a phone, "No changes yet" took a third of the dock.
  const pending = Boolean(plan) && plan!.mode !== 'unchanged';
  const caution = plan?.mode === 'blocked' || (plan?.mode === 'reflow' && (overrun > 0 || overflowsWidth));
  const status = !plan || plan.mode === 'unchanged'
    ? ''
    : plan.mode === 'direct'
      ? t("pdf-paragraph-inspector.status.saves.in.place")
      : plan.mode === 'blocked'
        ? t("pdf-paragraph-inspector.status.cannot.change")
        : overrun > 0
          ? t("pdf-paragraph-inspector.status.overlaps.below")
          : overflowsWidth
            ? t("pdf-paragraph-inspector.status.longer.than.line")
            : font?.mode === 'embedded'
              ? t("pdf-paragraph-inspector.status.redraws")
              : t("pdf-paragraph-inspector.status.redraws.in", { v0: t(`font.class.${font?.klass ?? 'sans-serif'}`) });
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Found on a phone: details opened while typing stayed open once the keyboard closed, over the
  // typeface and colour rows. Opening or closing the keyboard puts them away.
  useEffect(() => {
    const observer = new MutationObserver(() => setDetailsOpen(false));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-chef-keyboard'] });
    return () => observer.disconnect();
  }, []);

  const stepFontSize = (delta: number) => onUpdate({
    fontSize: Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round((fontSize + delta) * 10) / 10)),
  });

  // Buttons, not a select: a native picker takes focus and the keyboard with it.
  const typefaceGroup = (
    <div
      role="group"
      aria-label={t("pdf-paragraph-inspector.typeface.3a8c10")}
      className={compact ? 'flex shrink-0 items-center gap-0.5' : 'flex shrink-0 items-center gap-0.5 rounded-[var(--radius-control)] border border-[var(--border-strong)] p-0.5'}
    >
      {TYPEFACES.map((typeface) => (
        <button
          key={typeface.value}
          type="button"
          aria-pressed={activeTypeface === typeface.value}
          onPointerDown={keepCaret}
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

  // On a phone these sit straight on the bar, without outlines: found on a phone, the outlined
  // boxes looked heavier than the text they format. Each button keeps a 40px-wide box and reaches
  // the touch height through `chef-hit-y`, so the lighter look costs no reach.
  const groupClass = compact
    ? 'flex shrink-0 items-center'
    : 'flex shrink-0 items-center gap-0.5 rounded-[var(--radius-control)] border border-[var(--border-strong)] p-0.5';
  const segmentClass = `chef-pressable chef-hit-y rounded-[calc(var(--radius-control)-2px)] ${compact ? 'h-8 w-10' : 'h-9 w-9'}`;

  const emphasisGroup = (
    <div role="group" aria-label={t("pdf-paragraph-inspector.emphasis.0ab4b2")} className={groupClass}>
      <button
        type="button"
        aria-label={t("pdf-paragraph-inspector.bold.94fee6")}
        aria-pressed={bold}
        onPointerDown={keepCaret}
        onClick={() => {
          const next = !bold;
          setOverride({ bold: next === (descriptor?.bold ?? false) ? null : next });
        }}
        className={`${segmentClass} text-sm font-black ${bold ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : 'text-[var(--text-secondary)]'}`}
      >{t("pdf-paragraph-inspector.b.df7e70")}</button>
      <button
        type="button"
        aria-label={t("pdf-paragraph-inspector.italic.9bf37c")}
        aria-pressed={italic}
        onPointerDown={keepCaret}
        onClick={() => {
          const next = !italic;
          setOverride({ italic: next === (descriptor?.italic ?? false) ? null : next });
        }}
        className={`${segmentClass} font-serif text-sm italic ${italic ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : 'text-[var(--text-secondary)]'}`}
      >{t("pdf-paragraph-inspector.i.a83dd0")}</button>
    </div>
  );

  // Steps are half a point, so a whole size reads "12" and only a half shows its decimal.
  const sizeGroup = (
    <div role="group" aria-label={t("pdf-paragraph-inspector.text.size.d68761")} className={groupClass}>
      <button
        type="button"
        aria-label={t("pdf-paragraph-inspector.decrease.text.size.e63b95")}
        onPointerDown={keepCaret}
        onClick={() => stepFontSize(-0.5)}
        className={`${segmentClass} grid place-items-center text-[var(--text-secondary)]`}
      ><Minus aria-hidden size={16} /></button>
      <span className={`tabular text-center text-xs font-bold text-[var(--text-primary)] ${compact ? 'min-w-[2.25rem]' : 'min-w-[2.75rem]'}`}>
        {formatNumber(fontSize, { maximumFractionDigits: 1 })}
      </span>
      <button
        type="button"
        aria-label={t("pdf-paragraph-inspector.increase.text.size.4b1980")}
        onPointerDown={keepCaret}
        onClick={() => stepFontSize(0.5)}
        className={`${segmentClass} grid place-items-center text-[var(--text-secondary)]`}
      ><Plus aria-hidden size={16} /></button>
    </div>
  );

  // A few fixed colours, the paragraph's own ink first, then the platform's picker for anything
  // else. Android's picker on its own offers only eight primaries.
  const currentColour = (edit?.color ?? ink ?? '#000000').toLowerCase();
  const swatches = [
    ...(ink ? [{ colour: ink.toLowerCase(), label: t("pdf-paragraph-inspector.colour.original") }] : []),
    ...SWATCHES.filter((swatch) => swatch.colour !== ink?.toLowerCase())
      .map((swatch) => ({ colour: swatch.colour, label: swatch.label })),
  ];
  const colourField = (
    <div role="group" aria-label={t("pdf-paragraph-inspector.text.colour.25e9c8")} className="flex shrink-0 items-center gap-0.5">
      {swatches.map((swatch) => (
        <button
          key={swatch.colour}
          type="button"
          aria-label={swatch.label}
          aria-pressed={currentColour === swatch.colour}
          onPointerDown={keepCaret}
          onClick={() => onUpdate({ color: swatch.colour })}
          className="chef-pressable chef-hit-y grid h-9 w-9 place-items-center rounded-full"
        >
          <span
            aria-hidden
            className={`h-6 w-6 rounded-full border border-[var(--border-strong)] ${currentColour === swatch.colour ? 'outline outline-2 outline-offset-2 outline-[var(--accent-rest)]' : ''}`}
            style={{ backgroundColor: swatch.colour }}
          />
        </button>
      ))}
      <label className="chef-pressable chef-hit-y relative grid h-9 w-9 place-items-center rounded-full text-[var(--text-secondary)]">
        <Palette aria-hidden size={18} />
        <input
          type="color"
          aria-label={t("pdf-paragraph-inspector.colour.more")}
          value={currentColour}
          onChange={(event) => onUpdate({ color: event.target.value })}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
    </div>
  );

  const revertButton = isDirty ? (
    <button
      type="button"
      onClick={onRevert}
      aria-label={t("pdf-paragraph-inspector.revert.this.paragraph.6e2d05")}
      className="chef-pressable chef-hit-y inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-xs font-bold text-[var(--text-secondary)]"
    ><RotateCcw aria-hidden size={15} /><span>{t("pdf-paragraph-inspector.revert.0026c5")}</span></button>
  ) : null;

  // On a phone Done is a quiet word, like a keyboard's own: Save in the header stays the one
  // filled action on screen.
  const doneButton = compact ? (
    <button
      type="button"
      onClick={onDone}
      className="chef-pressable chef-hit-y inline-flex h-8 shrink-0 items-center rounded-[var(--radius-control)] px-3 text-sm font-bold text-[var(--accent-text)]"
    >{t("pdf-paragraph-inspector.done.12e9a0")}</button>
  ) : (
    <button
      type="button"
      onClick={onDone}
      className="chef-pressable chef-hit-y inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-3 text-xs font-bold text-[var(--text-on-accent)]"
    ><Check aria-hidden size={15} />{t("pdf-paragraph-inspector.done.12e9a0")}</button>
  );

  const detailsToggle = pending ? (
    <button
      type="button"
      aria-label={t("pdf-paragraph-inspector.status.details")}
      aria-expanded={detailsOpen}
      aria-controls={`pdf-paragraph-details-${block.id}`}
      onPointerDown={keepCaret}
      onClick={() => setDetailsOpen((open) => !open)}
      className={`chef-pressable chef-hit-y grid shrink-0 place-items-center rounded-[var(--radius-control)] ${compact ? 'h-8 w-10' : 'h-8 w-touch'} ${detailsOpen ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : 'text-[var(--text-secondary)]'}`}
    ><Info aria-hidden size={compact ? 16 : 17} /></button>
  ) : null;

  const details = (
    <p
      id={`pdf-paragraph-details-${block.id}`}
      data-testid="pdf-paragraph-provenance"
      hidden={!detailsOpen || !pending}
      className={`px-0.5 text-sm leading-snug text-[var(--text-secondary)] ${compact ? 'max-h-[7.5rem] overflow-y-auto pt-1.5' : 'mt-1'}`}
    >
      {/* Which typeface is drawing the paragraph is worth knowing while it can still be changed.
          Once the answer is no it is only noise in front of the one sentence that matters. */}
      {plan?.mode === 'blocked' ? outcome : t("pdf-paragraph-inspector..b8832c", { v0: provenance, v1: outcome })}
      {overflowsWidth && plan?.mode !== 'blocked' ? ` ${t("pdf-text-block-layer.text.extends.beyond.its.original.space.press.a351d0")}` : null}
    </p>
  );

  // The status is always announced. On a phone a caution is always shown, above the row; the
  // ordinary outcome waits behind the details button while the keyboard is up and shows once it
  // closes. Nothing has changed, nothing is shown.
  const statusVisibility = !status ? 'sr-only' : caution ? 'flex' : 'chef-sr-while-typing flex';

  return (
    <section
      data-testid="pdf-paragraph-inspector"
      aria-label={t("pdf-paragraph-inspector.paragraph.formatting.b29313")}
      className={compact
        ? 'chef-paragraph-dock relative mx-auto mb-2 max-w-md border-b border-[var(--border-hairline)] pb-1'
        : 'min-w-0 flex-1'}
    >
      {/* A phone wraps rather than scrolling sideways: every control has to be reachable without
          discovering that the strip moves. While the keyboard is up only the row a typist reaches
          for stays, flat on the bar, so the page keeps the height; typeface, colour and Revert come
          back with the keyboard closed. A wide screen fits them all on one line. */}
      {compact ? (
        <div className="flex flex-col">
          <div className="chef-hide-while-typing flex flex-wrap items-center gap-1.5 pb-1.5">
            {typefaceGroup}
            <span className="flex-1" />
            {revertButton}
          </div>
          <div className="chef-hide-while-typing flex items-center">
            {colourField}
          </div>
          {details}
          {/* Its own row, clear of the field's focus ring under it (review 2, item 14). */}
          <p
            data-testid="pdf-paragraph-status"
            role="status"
            className={`${statusVisibility} items-start gap-1.5 px-0.5 pb-2 pt-1 text-sm font-medium leading-5 ${caution ? 'text-[var(--status-caution-text)]' : 'text-[var(--text-secondary)]'}`}
          >{caution && <AlertTriangle aria-hidden size={16} className="mt-0.5 shrink-0" />}{status}</p>
          {field}
          <div className="flex min-h-11 flex-wrap items-center gap-x-1.5">
            {emphasisGroup}
            {sizeGroup}
            <span className="flex-1" />
            {detailsToggle}
            {doneButton}
          </div>
        </div>
      ) : (
        <>
          {/* A wide screen draws this row in the page panel's top band, beside the zoom, where the
              room already is: choosing a paragraph moves nothing (path to 9, part 2). */}
          <div className="flex min-h-12 flex-wrap items-center gap-1.5">
            {typefaceGroup}
            {emphasisGroup}
            {sizeGroup}
            <span className="text-xs font-semibold text-[var(--text-secondary)]">{t("pdf-paragraph-inspector.pt.e75b11")}</span>
            {colourField}
            <span className="flex-1" />
            {revertButton}
            {doneButton}
          </div>
          {/* This line is the answer to "what will saving do to my document", so it is set at the
              body size rather than the smallest one available. It takes a line only once there is
              something to say; until then it is only announced. */}
          <div className={status ? 'mt-1 flex min-h-8 items-center gap-1 px-0.5' : 'sr-only'}>
            <p
              data-testid="pdf-paragraph-status"
              role="status"
              className={`min-w-0 flex-1 text-sm font-medium leading-snug ${caution ? 'text-[var(--status-caution-text)]' : 'text-[var(--text-secondary)]'}`}
            >{status}</p>
            {detailsToggle}
          </div>
          {details}
        </>
      )}
    </section>
  );
};
