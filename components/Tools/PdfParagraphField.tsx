import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useLayoutEffect, useRef } from 'react';
import {
  blockStyledSegments, moveSoftBreaks, preserveStyledTextEdit, softLineBreaks, type StyledSegment,
} from '../../services/pdfBlockEditPlanning';
import type { PdfTextBlock } from '../../services/pdfTextBlocks';
import type { BlockEditState } from './PdfTextBlockLayer';

/**
 * Where a phone types into a paragraph: a wrapped field at a readable size above the keyboard.
 *
 * On the page, a phone could never show both readable text and whole lines: 11 pt body text on A4
 * needs 165% to reach 10 px, which cut a fifth off every line. Here the text wraps at 16 px while
 * the page zooms only enough to show the whole paragraph and draws the result as it will be saved.
 *
 * A plain text field keeps the platform's own editing (keyboard, selection handles, autocorrect,
 * composition). Bold runs and colours survive because every change is mapped back onto the
 * paragraph's styled segments, the same way the page editor handles a plain-text edit.
 */

const MAX_FIELD_HEIGHT = 104;

interface Props {
  block: PdfTextBlock;
  edit: BlockEditState | undefined;
  inks?: string[][];
  bold: boolean;
  italic: boolean;
  /** Changes whenever a tap asks for the caret at `offset`. */
  focusRequest: { blockId: string; offset: number; nonce: number } | null;
  onBeginChange: (blockId: string) => void;
  onChange: (blockId: string, text: string, segments: StyledSegment[][], softBreaks: number[]) => void;
}

export const PdfParagraphField: React.FC<Props> = ({
  block, edit, inks, bold, italic, focusRequest, onBeginChange, onChange,
}) => {
  useI18n();
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const text = edit?.text ?? block.text;
  const segments = useRef<StyledSegment[][]>(edit?.segments ?? blockStyledSegments(block, inks));
  segments.current = edit?.segments ?? blockStyledSegments(block, inks);
  const inputRange = useRef<{ start: number; end: number } | null>(null);
  // Undo, Replace all or Revert change the text from outside. The caret stays where it was
  // instead of jumping to the end.
  const typed = useRef(text);
  const lastSelection = useRef({ start: 0, end: 0 });
  // The PDF's own wrapping shows as spaces, so the field reads as one paragraph rather than a short
  // row at every line end. The text keeps those breaks: they decide what can still save in place.
  // The edit records them, so Undo or coming back to the paragraph does not guess them again.
  const soft = useRef<number[] | null>(null);
  if (soft.current === null || text !== typed.current) soft.current = edit?.softBreaks ?? softLineBreaks(text, block);
  const shown = soft.current.reduce((value, at) => (value[at] === '\n'
    ? `${value.slice(0, at)} ${value.slice(at + 1)}` : value), text);
  const shownBefore = useRef(shown);
  useLayoutEffect(() => {
    const field = fieldRef.current;
    const before = shownBefore.current;
    shownBefore.current = shown;
    if (!field || text === typed.current) return;
    typed.current = text;
    if (document.activeElement !== field) return;
    // Past the change, the caret moves with the text after it.
    let prefix = 0;
    while (prefix < before.length && prefix < shown.length && before[prefix] === shown[prefix]) prefix += 1;
    const move = (at: number) => (at <= prefix ? at : Math.max(prefix, at + shown.length - before.length));
    field.setSelectionRange(move(lastSelection.current.start), move(lastSelection.current.end));
  }, [shown, text]);

  // The selection just before the browser changes the text. A text diff alone cannot tell which of
  // two equal words was retyped.
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return undefined;
    const beforeInput = () => { inputRange.current = { start: field.selectionStart, end: field.selectionEnd }; };
    field.addEventListener('beforeinput', beforeInput);
    return () => field.removeEventListener('beforeinput', beforeInput);
  }, []);

  // One row per line of text, up to four, then the field scrolls.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight + 2, MAX_FIELD_HEIGHT)}px`;
  }, [text, bold, italic]);

  // After sizing, so the caret's row is measured in the field's final height.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field || !focusRequest || focusRequest.blockId !== block.id) return;
    field.focus({ preventScroll: true });
    const value = field.value;
    const at = Math.max(0, Math.min(focusRequest.offset, value.length));
    // The caret's wrapped row: the text up to it, laid out in the field, is that tall.
    field.value = value.slice(0, at);
    const caretBottom = field.scrollHeight;
    field.value = value;
    field.setSelectionRange(at, at);
    const lineHeight = Number.parseFloat(getComputedStyle(field).lineHeight) || 22;
    // scrollHeight is never less than the field, so "fits" also covers a caret on the first rows.
    field.scrollTop = caretBottom > field.clientHeight ? caretBottom - field.clientHeight + lineHeight : 0;
  }, [block.id, focusRequest]);

  return (
    <textarea
      ref={fieldRef}
      data-testid="pdf-paragraph-field"
      data-field-for={block.id}
      aria-label={t("pdf-text-block-layer.paragraph.on.page.b6bd50", { v0: block.pageIndex + 1, v1: block.text.slice(0, 80) })}
      value={shown}
      dir={block.direction}
      rows={1}
      spellCheck
      autoCapitalize="sentences"
      onChange={(event) => {
        const value = event.currentTarget.value.replace(/\r\n?/g, '\n');
        // A line break typed beside a soft space replaces it: two breaks would save a blank line.
        const moved = moveSoftBreaks(soft.current ?? [], shown, value, inputRange.current)
          .filter((at) => value[at - 1] !== '\n' && value[at + 1] !== '\n');
        const next = moved.reduce((result, at) => (result[at] === ' '
          ? `${result.slice(0, at)}\n${result.slice(at + 1)}` : result), value);
        soft.current = moved.filter((at) => next[at] === '\n');
        onBeginChange(block.id);
        const updated = preserveStyledTextEdit(segments.current, next,
          { text: '', fontKey: block.fontKey, fontSize: block.fontSize }, inputRange.current);
        inputRange.current = null;
        segments.current = updated;
        typed.current = next;
        onChange(block.id, next, updated, soft.current);
      }}
      onSelect={(event) => {
        lastSelection.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd };
      }}
      className="chef-field mb-1.5 block resize-none overflow-y-auto"
      style={{
        minHeight: 0, maxHeight: MAX_FIELD_HEIGHT, padding: '6px 10px', lineHeight: '22px',
        fontWeight: bold ? 700 : 400, fontStyle: italic ? 'italic' : 'normal',
      }}
    />
  );
};
