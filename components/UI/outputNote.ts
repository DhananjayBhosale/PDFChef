/**
 * A tool's own success message, handed to the result strip (owner decision 2, M-04).
 *
 * When a job ends with a result, the tool's status line ("Signed copy ready: sign.pdf.",
 * "Fillable PDF downloaded with 13 reviewed fields. Test every field before sharing.")
 * is not shown as a second toast: the status toast hands it here, and the result strip
 * shows it as its notice line under "PDF exported", until the result is dismissed or
 * replaced. It is sent after the current event turn, so it always lands on the result
 * that has just been announced.
 */
export const OUTPUT_NOTE_EVENT = 'pdfchef:output-note';

export const announceOutputNote = (message: string) => {
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent<string>(OUTPUT_NOTE_EVENT, { detail: message }));
  }, 0);
};

/* The note the strip shows now, so a tool's own notice line does not repeat it. */
let stripNote = '';
const listeners = new Set<() => void>();

export const setStripNote = (note: string) => {
  if (note === stripNote) return;
  stripNote = note;
  listeners.forEach((listener) => listener());
};

export const subscribeStripNote = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const getStripNote = () => stripNote;

/*
 * A tool's own figure for the strip's second line, in place of the bare size (Compress's
 * "3.0 MB → 728 kB, −77%", T-01). Set just before the result is announced and taken by
 * the announcement whose file name matches, so it never lands on another tool's result.
 */
let nextDetail: { filename: string; text: string } | null = null;

export const setNextOutputDetail = (filename: string, text: string) => {
  nextDetail = { filename, text };
};

export const takeOutputDetail = (filename: string | undefined): string => {
  const pending = nextDetail;
  if (!pending || pending.filename !== filename) return '';
  nextDetail = null;
  return pending.text;
};

/*
 * True while a result strip is drawn in this tool's own action area. The tool's outcome line
 * ("Created crop.pdf.", "Word document ready.") then says nothing the strip does not (T-07).
 */
let stripInSlot = false;
const slotListeners = new Set<() => void>();

export const setStripInSlot = (shown: boolean) => {
  if (shown === stripInSlot) return;
  stripInSlot = shown;
  slotListeners.forEach((listener) => listener());
};

export const subscribeStripInSlot = (listener: () => void) => {
  slotListeners.add(listener);
  return () => { slotListeners.delete(listener); };
};

export const getStripInSlot = () => stripInSlot;

/*
 * True while this tool's strip holds a result that is saved somewhere (Downloads, a share, Recent)
 * and still matches the tool's settings and file. Leaving the tool then asks nothing (final fix,
 * item 6): the work is not lost.
 */
let stripSaved = false;

export const setStripSaved = (saved: boolean) => { stripSaved = saved; };

export const getStripSaved = () => stripSaved;
