import React, { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronDown } from 'lucide-react';
import { pendingTextProps, t, type TranslationKey } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import { Pop, openerProps, usePop, type PopState } from './Popover';
import { ToolNoticeContext, editorNotice } from './parts';
import { useWide } from '../../hooks/useMediaQuery';
import { setWorkPart } from '../UI/workSignature';

/**
 * The settings of a tool as one translated sentence (plan 2.1).
 *
 * The template is one whole message with named placeholders. It is formatted with a
 * private-use sentinel in each slot's place, split on the sentinels, and drawn as text
 * nodes and slots in that order, so word order is the translator's. Nothing is joined.
 *
 * Every slot is a button that opens an editor holding today's control (with today's
 * name and handler); the editor stays mounted while closed, so a typed draft survives.
 * The accessible name is "{setting name}, {visible value}". When the sentence needs a
 * third line (long language, large text, narrow phone) it is drawn as labelled rows
 * instead, with the same buttons, editors and names; so does a phone sentence with four or
 * more values (owner decision 2026-11-15). A statement (no slots) is drawn at
 * one statement size, short or long (`data-form="statement"`, T-15), so sibling tools match.
 */

export interface SlotDef {
  /** The setting name: the start of the accessible name, and the label in the rows form. */
  label: string;
  /** The visible value, already translated. */
  text?: string;
  /** A fuller value for the accessible name (must contain `text`). */
  nameText?: string;
  /** A 16px glyph before the value (compact sentences). Decorative. */
  icon?: React.ReactNode;
  tone?: 'pending' | 'error';
  /** 'ltr' for ranges, pairs and signed numbers. */
  bidi?: 'auto' | 'ltr';
  /** The editor: today's control(s). */
  editor?: React.ReactNode;
  editorTitle?: string;
  /** Show the editor title visibly (default true). */
  showTitle?: boolean;
  /** Phone: open the editor without the dim scrim (live-preview tools). */
  quiet?: boolean;
  /** A control drawn in place of a button (the colour input, Rotate's two action words). It keeps its own name. */
  inline?: React.ReactNode;
  /** Plain text, not a control. */
  static?: boolean;
  /** Popover width on desktop. */
  width?: number;
  /** How much of the screen the live preview keeps while the card is open (Popover `previewFloor`). */
  previewFloor?: number;
  /**
   * The line drawn under the editor's controls while it is open. By default the tool's
   * own notice line (errors, pending and outcome lines), which the open editor covers;
   * null when the editor already shows the same message itself.
   */
  notice?: React.ReactNode;
  /** Clicking the slot focuses this control instead of opening an editor (a field already on screen). */
  focusTarget?: () => HTMLElement | null;
}

const OPEN = '';
const CLOSE = '';
const SPLIT = /(\d+)/;
/**
 * Closing punctuation that follows a value with no space ("…at [14 pt]." or "[2 files],"): drawn
 * with the value in one unbreakable piece, so a full stop never wraps alone onto its own line (iOS
 * sync, overnight 2026-11-24: Page Numbers' "Page 1 of 3" at 402 px). A no-break space before it
 * (French « … ») goes with it.
 */
const TRAILING = /^[\u00a0\u202f\u2066-\u2069]*[\p{Pe}\p{Pf}\p{Po}]+/u;

type Values = Record<string, string | number>;
const tr = t as unknown as (key: TranslationKey, values?: Values) => string;

const slotName = (def: SlotDef) => {
  const value = def.nameText ?? def.text ?? '';
  if (def.tone === 'error') return t('sentence.slot.nameInvalid', { label: def.label, value });
  if (def.tone === 'pending') return t('sentence.slot.namePending', { label: def.label, value });
  return t('sentence.slot.name', { label: def.label, value });
};

const Value: React.FC<{ def: SlotDef }> = ({ def }) => (
  <>
    {def.tone === 'error' && <AlertCircle aria-hidden size={14} strokeWidth={2} className="tk-slot-alert" />}
    {def.icon && <span aria-hidden className="tk-slot-icon">{def.icon}</span>}
    <bdi dir={def.bidi === 'ltr' ? 'ltr' : undefined} className="tk-slot-text">{def.text}</bdi>
  </>
);

const TYPING_FIELD = 'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea';
/** Marks a field for a moment, so a tap on its slot visibly leads to it. */
const pointAt = (field: HTMLElement) => {
  const mark = (field.closest('.chef-field, label') as HTMLElement | null) ?? field;
  mark.removeAttribute('data-pointed');
  void mark.offsetWidth;
  mark.setAttribute('data-pointed', '');
  window.setTimeout(() => mark.removeAttribute('data-pointed'), 1200);
};

const SlotButton: React.FC<{
  name: string;
  def: SlotDef;
  pop: PopState;
  popId: string;
  disabled: boolean;
  rows: boolean;
}> = ({ name, def, pop, popId, disabled, rows }) => {
  const opener = def.editor ? openerProps(pop, popId, name) : { type: 'button' as const };
  const common = {
    ...opener,
    'aria-label': slotName(def),
    'aria-disabled': disabled || undefined,
    'data-slot': name,
    'data-tone': def.tone,
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      if (disabled) { event.preventDefault(); return; }
      if (def.editor) { pop.toggle(event.currentTarget, name); return; }
      const target = def.focusTarget?.();
      if (target) {
        target.scrollIntoView({ block: 'nearest' });
        // A tap on a touch screen points at the field without focusing it: focus raises the
        // keyboard over the page grid that is the other way to choose (round 6, mobile-06). A
        // mouse click or a key press still focuses it.
        if (event.detail > 0 && target.matches(TYPING_FIELD) && window.matchMedia?.('(pointer: coarse)').matches) {
          pointAt(target);
          return;
        }
        target.focus();
      }
    },
  };
  if (rows) {
    return (
      <button {...common} className="tk-row chef-pressable">
        <span aria-hidden className="tk-row-label">{def.label}</span>
        <span className="tk-row-value"><Value def={def} /></span>
        {(def.editor || def.focusTarget) && <ChevronDown aria-hidden size={16} strokeWidth={1.75} className="tk-slot-caret" />}
      </button>
    );
  }
  return (
    <button {...common} className="tk-slot chef-pressable">
      <Value def={def} />
      {(def.editor || def.focusTarget) && <ChevronDown aria-hidden size={14} strokeWidth={2} className="tk-slot-caret" />}
    </button>
  );
};

export const Sentence: React.FC<{
  template: TranslationKey;
  /** Plain-text placeholders (not slots), already formatted. `count` stays a number for plural frames. */
  values?: Values;
  slots?: Record<string, SlotDef>;
  groupLabel: string;
  disabled?: boolean;
  form?: 'auto' | 'sentence' | 'rows';
  /** 16/36 instead of 19/36 (Watermark's band). */
  compact?: boolean;
  className?: string;
  /** The open editor's slot name, or null (Crop keeps its frame while an editor is open). */
  onEditorChange?: (name: string | null) => void;
  /** False for a line whose values do not change the result (Split's save choice). */
  work?: boolean;
}> = ({ template, values = {}, slots = {}, groupLabel, disabled = false, form = 'auto', compact = false, className, onEditorChange, work = true }) => {
  useI18n();
  const pop = usePop();
  // Desktop (T-10): a value whose control is drawn beside the sentence is text, not a button
  // that only moves focus there.
  const wide = useWide();
  const asText = (def: SlotDef) => wide && !def.editor && Boolean(def.focusTarget);
  const toolNotice = editorNotice(useContext(ToolNoticeContext));
  const openEditor = pop.open ? pop.openerKey : null;
  // Told only when the open editor changes: a caller that passes a new function on every
  // render (Crop) must not hear it again on each keystroke inside the editor.
  const editorChangeRef = useRef(onEditorChange);
  editorChangeRef.current = onEditorChange;
  useEffect(() => { editorChangeRef.current?.(openEditor); }, [openEditor]);
  const baseId = useId();
  const names = Object.keys(slots);
  const statement = names.length === 0;
  const popId = (name: string) => `tk-pop-${baseId.replace(/[^a-zA-Z0-9]/g, '')}-${name}`;

  const formatted = tr(template, { ...values, ...Object.fromEntries(names.map((name, index) => [name, `${OPEN}${index}${CLOSE}`])) });
  const parts = formatted.split(SPLIT);
  const plain = tr(template, { ...values, ...Object.fromEntries(names.map((name) => [name, slots[name].text ?? slots[name].label])) })
    .replace(/[⁦-⁩]/g, '');
  // An English frame inside another language reads left to right, in the Latin serif (plan 4.3).
  const pendingProps = pendingTextProps(template);
  // The settings as words, so the result strip can tell when they change after a result.
  // Keyed by its template and the layout, not by this instance: the sentence is drawn anew when the
  // layout crosses 768 px, and each layout words the values its own way (fix review, finding 4).
  const workKey = `sentence:${wide ? 'wide' : 'narrow'}:${template}`;
  useEffect(() => { if (work) setWorkPart(workKey, plain); }, [work, workKey, plain]);
  useEffect(() => () => { if (work) setWorkPart(workKey, null); }, [work, workKey]);

  /* ---- sentence or rows: measured on a hidden copy, so the choice never flips back and forth ---- */
  const measureRef = useRef<HTMLParagraphElement>(null);
  const sentenceRef = useRef<HTMLParagraphElement>(null);
  const [overflow, setOverflow] = useState(false);
  const signature = `${formatted}|${names.map((name) => `${slots[name].text}|${slots[name].tone}`).join('|')}`;

  useLayoutEffect(() => {
    if (form !== 'auto') return undefined;
    const node = measureRef.current;
    if (!node) return undefined;
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(node).lineHeight) || 36;
      const lines = Math.round(node.getBoundingClientRect().height / lineHeight);
      setOverflow(lines > 2);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [signature, form]);

  // Phone (owner decision 2026-11-15, item 3): four or more values read as labelled rows rather
  // than a long sentence. A control drawn inline (Rotate's left and right, Watermark's colour
  // swatch) and plain text are not values (owner decision 2026-11-24: Watermark's short sentence).
  const valueCount = names.filter((name) => !slots[name].static && !slots[name].inline).length;
  const many = !wide && valueCount >= 4;
  const rows = !statement && (form === 'rows' || (form === 'auto' && (overflow || many)));

  /* ---- each slot learns its line, so its touch area grows away from the other line ---- */
  useLayoutEffect(() => {
    const node = sentenceRef.current;
    if (rows || !node) return undefined;
    const assign = () => {
      const lineHeight = parseFloat(getComputedStyle(node).lineHeight) || 36;
      const box = node.getBoundingClientRect();
      const lines = Math.max(1, Math.round(box.height / lineHeight));
      node.dataset.lines = String(lines);
      node.querySelectorAll<HTMLElement>('[data-slot], [data-slot-inline]').forEach((slot) => {
        const rect = slot.getBoundingClientRect();
        const line = Math.min(lines - 1, Math.max(0, Math.floor((rect.top + rect.height / 2 - box.top) / lineHeight)));
        slot.dataset.line = lines === 1 ? 'only' : line === 0 ? 'first' : line === lines - 1 ? 'last' : 'mid';
      });
    };
    assign();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(assign);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [rows, signature]);

  /* ---- the whole sentence is spoken once, 600 ms after the last change ---- */
  const [spoken, setSpoken] = useState('');
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return undefined; }
    const timer = window.setTimeout(() => setSpoken(plain), 600);
    return () => window.clearTimeout(timer);
  }, [plain]);

  const renderSlot = (index: number, inRows: boolean) => {
    const name = names[index];
    const def = slots[name];
    if (!def) return null;
    if (def.inline) {
      return inRows ? (
        <div key={name} className="tk-row tk-row-inline" data-slot-inline={name}>
          <span aria-hidden className="tk-row-label">{def.label}</span>
          <span className="tk-row-value">{def.inline}</span>
        </div>
      ) : <span key={name} className="tk-inline" data-slot-inline={name}>{def.inline}</span>;
    }
    if (def.static) {
      return inRows ? (
        <div key={name} className="tk-row tk-row-static">
          <span className="tk-row-label">{def.label}</span>
          <span className="tk-row-value"><bdi>{def.text}</bdi></span>
        </div>
      ) : <span key={name} className="tk-static"><bdi dir={def.bidi === 'ltr' ? 'ltr' : undefined}>{def.text}</bdi></span>;
    }
    if (asText(def)) {
      return inRows ? (
        <div key={name} className="tk-row tk-row-static" data-slot-text={name}>
          <span className="tk-row-label">{def.label}</span>
          <span className="tk-row-value tk-value"><Value def={def} /></span>
        </div>
      ) : <strong key={name} className="tk-value" data-slot-text={name} data-tone={def.tone}><Value def={def} /></strong>;
    }
    return <SlotButton key={name} name={name} def={def} pop={pop} popId={popId(name)} disabled={disabled} rows={inRows} />;
  };

  // Closing punctuation right after a value drawn as a box (a slot, an inline control) is drawn
  // with it (TRAILING). Plain-text values already keep their punctuation on their line.
  const glueAt = (index: number) => {
    const def = slots[names[Number(parts[index])]];
    return def && !def.static && !asText(def) ? parts[index + 1]?.match(TRAILING)?.[0] ?? '' : '';
  };

  const measureSlot = (index: number) => {
    const def = slots[names[index]];
    if (!def) return null;
    return (
      <span key={index} className={def.inline ? 'tk-inline' : def.static ? 'tk-static' : asText(def) ? 'tk-value' : 'tk-slot'}>
        {def.inline
          ? (def.text
            // An action word (Rotate): measured as a pill of the same text.
            ? <span className="tk-word tk-measure-word"><span className="tk-measure-caret" />{def.text}</span>
            : <span className="tk-measure-inline" />)
          : <>
            {def.icon && <span className="tk-slot-icon" />}
            {def.text}
            {(def.editor || def.focusTarget) && !asText(def) && <span className="tk-slot-caret tk-measure-caret" />}
          </>}
      </span>
    );
  };

  return (
    <div
      role="group"
      aria-label={groupLabel}
      className={`tk-sentence-group${className ? ` ${className}` : ''}`}
      data-form={rows ? 'rows' : statement ? 'statement' : 'sentence'}
      data-disabled={disabled ? '' : undefined}
      data-compact={compact ? '' : undefined}
      data-work-ignore={work ? undefined : ''}
      {...pendingProps}
    >
      {/* The measuring copy: same type, same slot boxes, no controls. */}
      {form === 'auto' && (
        <p ref={measureRef} aria-hidden className="tk-sentence tk-measure">
          {parts.map((part, index) => {
            if (index % 2 === 0) return index > 0 ? part.slice(glueAt(index - 1).length) : part;
            const glued = glueAt(index);
            return glued ? <span key={index} className="tk-glue">{measureSlot(Number(part))}{glued}</span> : measureSlot(Number(part));
          })}
        </p>
      )}
      {rows ? (
        <div className="tk-rows" data-many={many ? '' : undefined}>{names.map((_, index) => renderSlot(index, true))}</div>
      ) : (
        <p ref={sentenceRef} className="tk-sentence">
          {parts.map((part, index) => {
            // The text after a value starts without the punctuation drawn with that value.
            if (index % 2 === 0) {
              const text = index > 0 ? part.slice(glueAt(index - 1).length) : part;
              return text ? <React.Fragment key={index}>{text}</React.Fragment> : null;
            }
            const glued = glueAt(index);
            return glued
              ? <span key={index} className="tk-glue">{renderSlot(Number(part), false)}{glued}</span>
              : renderSlot(Number(part), false);
          })}
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{spoken}</p>
      {names.map((name) => slots[name].editor && (
        <Pop
          key={name}
          pop={{ ...pop, open: pop.open && pop.openerKey === name }}
          id={popId(name)}
          title={slots[name].editorTitle ?? slots[name].label}
          showTitle={slots[name].showTitle ?? true}
          quiet={slots[name].quiet}
          width={slots[name].width ?? 340}
          previewFloor={slots[name].previewFloor}
          notice={'notice' in slots[name] ? slots[name].notice : toolNotice}
        >
          {slots[name].editor}
        </Pop>
      ))}
    </div>
  );
};

/**
 * One opener that is not part of a sentence (Watermark's and Page numbers' position
 * read-out under the preview). Same mechanics as a slot.
 */
export const ChipEditor: React.FC<{
  label: string;
  text: string;
  editor: React.ReactNode;
  editorTitle?: string;
  quiet?: boolean;
  disabled?: boolean;
  className?: string;
  /** A 16px glyph before the value, so the chip reads as a control (Page Numbers' position). */
  icon?: React.ReactNode;
  /** How much of the screen the live preview keeps while the card is open (Popover `previewFloor`). */
  previewFloor?: number;
}> = ({ label, text, editor, editorTitle, quiet, disabled, className, icon, previewFloor }) => {
  const pop = usePop();
  const id = `tk-chip-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  // Keyed by its label and the layout, as the sentence is.
  const workKey = `chip:${useWide() ? 'wide' : 'narrow'}:${label}`;
  useEffect(() => { setWorkPart(workKey, text); }, [workKey, text]);
  useEffect(() => () => setWorkPart(workKey, null), [workKey]);
  return (
    <>
      <button
        {...openerProps(pop, id, 'main')}
        aria-label={t('sentence.slot.name', { label, value: text })}
        aria-disabled={disabled || undefined}
        onClick={(event) => { if (!disabled) pop.toggle(event.currentTarget, 'main'); }}
        className={`tk-chip-editor chef-pressable${className ? ` ${className}` : ''}`}
      >
        {icon && <span aria-hidden className="tk-slot-icon">{icon}</span>}
        <bdi dir="ltr" className="tabular">{text}</bdi>
        <ChevronDown aria-hidden size={14} strokeWidth={2} />
      </button>
      <Pop pop={pop} id={id} title={editorTitle ?? label} quiet={quiet} width={360} previewFloor={previewFloor}>{editor}</Pop>
    </>
  );
};
