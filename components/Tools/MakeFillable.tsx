import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FormInput, Loader2, ScanSearch, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { FileUpload } from '../UI/FileUpload';
import { StatusToast } from '../UI/StatusToast';
import { ToolHeader, ToolShell } from '../UI/ToolLayout';
import { Badge } from '../UI/Primitives';
import { getPageSelectableTextLines, getPdfFormFields, getPdfPagePreviews, loadPDFDocument } from '../../services/pdfBrowser';
import { createFillablePdf, detectVisualFormFields, type FillableFieldKind, type FillableFieldPlacement } from '../../services/fillableForms';
import { downloadBytes, revokeObjectUrls } from '../../services/pdfShared';
import { shouldWarnForFiles } from '../../services/workspace';
import type { ProcessingStatus } from '../../types';

const fieldKinds: Array<{ value: FillableFieldKind; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'multiline', label: 'Long text' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'radio', label: 'Radio' },
  { value: 'dropdown', label: 'Dropdown' },
];

const makeId = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const validFieldName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export const MakeFillable: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [fields, setFields] = useState<FillableFieldPlacement[]>([]);
  const [kind, setKind] = useState<FillableFieldKind>('text');
  const [name, setName] = useState('');
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState('Option 1, Option 2');
  const [existingFieldCount, setExistingFieldCount] = useState(0);
  const [pendingReviewIds, setPendingReviewIds] = useState<Set<string>>(() => new Set());
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [touchDrawMode, setTouchDrawMode] = useState(false);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => revokeObjectUrls(previews), [previews]);

  const fieldsOnPage = useMemo(() => fields.filter((field) => field.pageIndex === pageIndex), [fields, pageIndex]);
  const pendingReviewCount = pendingReviewIds.size;
  const validationMessages = useMemo(() => {
    const messages: string[] = [];
    if (fields.length === 0) messages.push('Add at least one field before creating a fillable PDF.');
    if (pendingReviewCount > 0) messages.push(`Keep or remove the ${pendingReviewCount} suggested field${pendingReviewCount === 1 ? '' : 's'} still awaiting review.`);
    if (fields.some((field) => !validFieldName.test(field.name))) messages.push('Field names must start with a letter and use only letters, numbers, _ or -.');
    if (new Set(fields.map((field) => field.name.toLowerCase())).size !== fields.length) messages.push('Field names must be unique.');
    return messages;
  }, [fields, pendingReviewCount]);

  const removeField = (id: string) => {
    setFields((current) => current.filter((field) => field.id !== id));
    setPendingReviewIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setSelectedFieldId((current) => current === id ? null : current);
  };

  const keepSuggestion = (id: string) => {
    setPendingReviewIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const goToPage = (nextPageIndex: number) => {
    if (previews.length === 0) return;
    setPageIndex(Math.max(0, Math.min(previews.length - 1, nextPageIndex)));
    setSelectedFieldId(null);
    setTouchDrawMode(false);
  };

  const select = async (files: File[]) => {
    const selected = files[0];
    if (!selected) return;
    if (shouldWarnForFiles([selected]) && !window.confirm('This is a large PDF and may use substantial browser memory. Continue?')) return;
    setStatus({ isProcessing: true, progress: 10, message: 'Preparing pages…' });
    let pdf: any = null;
    try {
      revokeObjectUrls(previews);
      pdf = await loadPDFDocument(selected);
      if (pdf?.isPureXfa) {
        throw new Error('XFA forms are not supported. Export a standard PDF copy first.');
      }
      const existingFields = await getPdfFormFields(pdf);
      const nextPreviews = await getPdfPagePreviews(selected, { scale: 0.8 });
      setFile(selected);
      setPreviews(nextPreviews);
      setFields([]);
      setPendingReviewIds(new Set());
      setSelectedFieldId(null);
      setTouchDrawMode(false);
      setExistingFieldCount(new Set(existingFields.map((field) => field.fieldName)).size);
      setPageIndex(0);
      setStatus({ isProcessing: false, progress: 100, message: 'Ready. Draw fields manually or ask for local suggestions.' });
    } catch (error) {
      setFile(null);
      setExistingFieldCount(0);
      setStatus({ isProcessing: false, progress: 0, message: '', error: error instanceof Error ? error.message : 'Unable to open this PDF.' });
    } finally {
      if (pdf?.destroy) void pdf.destroy();
    }
  };

  const addField = (x: number, y: number, width: number, height: number) => {
    const isSquare = kind === 'checkbox' || kind === 'radio';
    const side = Math.max(0.035, Math.min(width, height));
    const nextName = name.trim() || `${kind}_${fields.length + 1}`;
    const id = makeId();
    setFields((current) => [...current, {
      id,
      name: nextName,
      kind,
      pageIndex,
      x,
      y,
      width: isSquare ? side : Math.max(0.08, width),
      height: isSquare ? side : Math.max(0.025, height),
      required,
      options: kind === 'dropdown' ? options.split(',').map((item) => item.trim()).filter(Boolean) : undefined,
      radioGroup: kind === 'radio' ? 'choice' : undefined,
    }]);
    setSelectedFieldId(id);
    setName('');
  };

  const pointerPosition = (event: React.PointerEvent) => {
    const rect = previewRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };

  const suggestFields = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 5, message: 'Looking for likely field labels…' });
    let pdf: any = null;
    try {
      pdf = await loadPDFDocument(file);
      const suggestions: FillableFieldPlacement[] = [];
      for (let index = 0; index < pdf.numPages; index += 1) {
        if (suggestions.length >= 80) break;
        const page = await pdf.getPage(index + 1);
        const viewport = page.getViewport({ scale: 1 });
        const lines = await getPageSelectableTextLines(pdf, index, 1);
        for (const line of lines) {
          if (suggestions.length >= 80) break;
          const looksLikeLabel = /[:?]\s*$/.test(line.text) || /\b(name|date|email|phone|address|city|state|country|signature|amount|company|title)\b/i.test(line.text);
          if (!looksLikeLabel) continue;
          const left = Math.min(0.72, Math.max(0.03, (line.left + line.width + 10) / viewport.width));
          const top = Math.max(0.02, (line.top - 2) / viewport.height);
          suggestions.push({
            id: makeId(),
            name: line.text.replace(/[:?]+$/, '').trim().replace(/\W+/g, '_').toLowerCase() || `field_${suggestions.length + 1}`,
            kind: 'text',
            pageIndex: index,
            x: left,
            y: top,
            width: Math.max(0.16, Math.min(0.42, 0.96 - left)),
            height: Math.max(0.032, Math.min(0.07, line.height * 1.6 / viewport.height)),
            required: false,
          });
        }
        if (suggestions.length >= 80) break;
        const visualCandidates = await detectVisualFormFields(previews[index]);
        for (const candidate of visualCandidates) {
          if (suggestions.length >= 80) break;
          const duplicate = suggestions.some((existing) => existing.pageIndex === index
            && Math.abs(existing.x - candidate.x) < 0.035
            && Math.abs(existing.y - candidate.y) < 0.035);
          if (duplicate) continue;
          suggestions.push({
            id: makeId(),
            name: `${candidate.kind}_${suggestions.length + 1}`,
            kind: candidate.kind,
            pageIndex: index,
            x: candidate.x,
            y: candidate.y,
            width: candidate.width,
            height: candidate.height,
            required: false,
          });
        }
        if (suggestions.length >= 80) break;
        setStatus({ isProcessing: true, progress: Math.round((index + 1) / pdf.numPages * 90), message: `Checking labels and visible field shapes on page ${index + 1} of ${pdf.numPages}…` });
      }
      setFields((current) => [...current, ...suggestions]);
      setPendingReviewIds((current) => {
        const next = new Set(current);
        suggestions.forEach((suggestion) => next.add(suggestion.id));
        return next;
      });
      setSelectedFieldId(suggestions[0]?.id ?? null);
      if (suggestions[0]) setPageIndex(suggestions[0].pageIndex);
      setStatus({ isProcessing: false, progress: 100, message: suggestions.length ? `Added ${suggestions.length} suggestions. Keep or remove every suggestion before export.` : 'No likely labels or field shapes were found. Add fields manually.' });
    } catch (error) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: error instanceof Error ? error.message : 'Field suggestions failed.' });
    } finally {
      if (pdf?.destroy) void pdf.destroy();
    }
  };

  const exportPdf = async () => {
    if (!file) return;
    if (validationMessages.length > 0) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: validationMessages[0] });
      return;
    }
    setStatus({ isProcessing: true, progress: 20, message: 'Writing form fields…' });
    try {
      const bytes = await createFillablePdf(file, fields);
      downloadBytes(bytes, `${file.name.replace(/\.pdf$/i, '')}-fillable.pdf`, 'application/pdf');
      setStatus({ isProcessing: false, progress: 100, message: `Fillable PDF downloaded with ${fields.length} reviewed field${fields.length === 1 ? '' : 's'}. Test every field before sharing.` });
    } catch (error) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: error instanceof Error ? error.message : 'Unable to create the fillable PDF.' });
    }
  };

  if (!file) {
    return (
      <ToolShell centered>
        {/* Kept: detection is heuristic, and an unreviewed field ships in the export. */}
        <ToolHeader
          title={<>Make Fillable <Badge tone="caution" className="align-middle">Beta</Badge></>}
          note={<span className="font-medium text-[var(--status-caution-text)]">Suggestions can be wrong, so review every field before sharing.</span>}
        />
        <FileUpload onFilesSelected={(files) => void select(files)} accept=".pdf,application/pdf" label="Choose a PDF to make fillable" />
        <StatusToast status={status} />
      </ToolShell>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-4 sm:py-8">
      <div className="flex flex-wrap items-start justify-between gap-2.5">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold text-[var(--text-primary)]">Make Fillable <Badge tone="caution" className="align-middle">Beta</Badge></h1>
          <p className="break-words text-sm text-[var(--text-secondary)]">{file.name} · {fields.length} new field{fields.length === 1 ? '' : 's'}{pendingReviewCount > 0 ? ` · ${pendingReviewCount} to review` : ''}</p>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:w-auto">
          <button type="button" onClick={() => void suggestFields()} disabled={status.isProcessing} className="chef-target chef-pressable inline-flex min-w-0 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 text-sm font-bold text-[var(--text-primary)] hover:border-[var(--accent-rest)] disabled:opacity-55"><ScanSearch size={18} /> Detect fields</button>
          <button type="button" onClick={() => void exportPdf()} disabled={status.isProcessing || validationMessages.length > 0} aria-describedby="fillable-validation" className="chef-target chef-pressable inline-flex min-w-0 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-3 text-sm font-bold text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)] disabled:opacity-55">{status.isProcessing ? <Loader2 className="animate-spin" size={18} /> : <FormInput size={18} />} Create fillable PDF</button>
        </div>
      </div>

      <div id="fillable-validation" aria-live="polite" className="mt-3 rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] px-3 py-2.5 text-sm text-[var(--text-secondary)]">
        <p><strong>Review first:</strong> every detected box is a suggestion until you choose Keep.</p>
        {existingFieldCount > 0 && <p className="mt-1">New fields are added alongside the {existingFieldCount} fillable field{existingFieldCount === 1 ? '' : 's'} this PDF already has.</p>}
        {validationMessages.length > 0
          ? <ul className="mt-2 list-disc space-y-1 pl-5 text-amber-800 dark:text-amber-200">{validationMessages.map((message) => <li key={message}>{message}</li>)}</ul>
          : <p className="mt-2 font-semibold text-emerald-700 dark:text-emerald-300">All new fields are reviewed and ready to export.</p>}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)_310px]">
        <aside aria-label="New field settings" className="order-1 h-fit rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 lg:order-none">
          <h2 className="font-bold text-[var(--text-primary)]">New field</h2>
          <label className="mt-2.5 block text-sm font-semibold text-[var(--text-secondary)]">Type<select value={kind} onChange={(event) => setKind(event.target.value as FillableFieldKind)} className="chef-field mt-1">{fieldKinds.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label className="mt-3 block text-sm font-semibold text-[var(--text-secondary)]">Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder={`${kind}_${fields.length + 1}`} className="chef-field mt-1" /></label>
          {kind === 'dropdown' && <label className="mt-3 block text-sm font-semibold text-[var(--text-secondary)]">Options<input value={options} onChange={(event) => setOptions(event.target.value)} className="chef-field mt-1" /></label>}
          <label className="mt-3 flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--text-secondary)]"><input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} className="h-5 w-5 accent-blue-600" /> Required</label>
          {/* Kept: drawing a box is not visible anywhere on the page, and on
              touch the page scrolls instead unless draw mode is armed first. */}
          <p className="type-caption mt-2.5 font-normal normal-case tracking-normal text-[var(--text-secondary)]">Drag on the page to place it. On a phone, arm Draw field on page first.</p>
          <button type="button" aria-pressed={touchDrawMode} onClick={() => setTouchDrawMode((current) => !current)} className={`chef-target chef-pressable mt-2.5 w-full rounded-[var(--radius-control)] px-4 text-sm font-bold ${touchDrawMode ? 'bg-[var(--accent-rest)] text-[var(--text-on-accent)]' : 'border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text-primary)]'}`}>{touchDrawMode ? 'Cancel drawing' : 'Draw field on page'}</button>
          <button type="button" onClick={() => { revokeObjectUrls(previews); setFile(null); setPreviews([]); setFields([]); setPendingReviewIds(new Set()); setSelectedFieldId(null); setTouchDrawMode(false); setExistingFieldCount(0); }} className="chef-target chef-pressable mt-2.5 w-full rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 text-sm font-bold text-[var(--text-primary)] hover:border-[var(--accent-rest)]">Choose another PDF</button>
        </aside>

        <main className="order-2 min-w-0 overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)] p-3 lg:order-none">
          <div
            ref={previewRef}
            className={`relative mx-auto w-fit max-w-full select-none overflow-hidden bg-white shadow-[var(--elevation-panel)] ${touchDrawMode ? 'touch-none' : 'touch-auto'}`}
            onPointerDown={(event) => {
              if (!event.isPrimary || (event.pointerType === 'touch' && !touchDrawMode)) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              dragStart.current = pointerPosition(event);
            }}
            onPointerUp={(event) => {
              if (!event.isPrimary || (event.pointerType === 'touch' && !touchDrawMode)) return;
              const start = dragStart.current;
              const end = pointerPosition(event);
              dragStart.current = null;
              if (!start || !end) return;
              addField(Math.min(start.x, end.x), Math.min(start.y, end.y), Math.abs(end.x - start.x), Math.abs(end.y - start.y));
              if (event.pointerType === 'touch') setTouchDrawMode(false);
            }}
            onPointerCancel={() => { dragStart.current = null; setTouchDrawMode(false); }}
          >
            <img src={previews[pageIndex]} alt={`Page ${pageIndex + 1}`} className="block max-h-[72vh] max-w-full object-contain" draggable={false} />
            {fieldsOnPage.map((field) => (
              <button
                key={field.id}
                type="button"
                title={`${field.kind}: ${field.name}`}
                aria-label={`${pendingReviewIds.has(field.id) ? 'Suggested' : 'Reviewed'} ${field.kind} field ${field.name}`}
                aria-pressed={selectedFieldId === field.id}
                onPointerDown={(event) => event.stopPropagation()}
                onPointerUp={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedFieldId(field.id);
                }}
                className={`absolute text-left text-[10px] font-bold outline-none focus-visible:ring-2 focus-visible:ring-slate-900 ${pendingReviewIds.has(field.id) ? 'border-2 border-dashed border-amber-600 bg-amber-300/20 text-amber-950' : 'border-2 border-blue-600 bg-blue-400/15 text-blue-950'} ${selectedFieldId === field.id ? 'ring-2 ring-slate-900 ring-offset-1' : ''}`}
                style={{ left: `${field.x * 100}%`, top: `${field.y * 100}%`, width: `${field.width * 100}%`, height: `${field.height * 100}%` }}
              >
                <span className={`absolute left-0 top-0 max-w-full truncate rounded px-1.5 py-0.5 text-white ${pendingReviewIds.has(field.id) ? 'bg-amber-700' : 'bg-blue-700'}`}>{pendingReviewIds.has(field.id) ? 'Review: ' : ''}{field.name}</span>
              </button>
            ))}
          </div>
          <nav aria-label="PDF pages" className="mt-3 flex items-center justify-center gap-2">
            <button type="button" onClick={() => goToPage(pageIndex - 1)} disabled={pageIndex === 0} className="chef-target chef-pressable rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-4 text-sm font-bold text-[var(--text-primary)] disabled:opacity-55">Previous</button>
            <span className="tabular min-w-24 text-center text-sm font-bold text-[var(--text-body)]">Page {pageIndex + 1} of {previews.length}</span>
            <button type="button" onClick={() => goToPage(pageIndex + 1)} disabled={pageIndex >= previews.length - 1} className="chef-target chef-pressable rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-4 text-sm font-bold text-[var(--text-primary)] disabled:opacity-55">Next</button>
          </nav>
        </main>

        <aside className="chef-scroller order-3 h-fit max-h-[78vh] overflow-auto rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 lg:order-none">
          <h2 className="font-bold text-[var(--text-primary)]">Fields on page {pageIndex + 1}</h2>
          {fieldsOnPage.length === 0 ? <p className="mt-2 text-sm text-[var(--text-secondary)]">No fields on this page.</p> : (
            <ul className="mt-2 space-y-2">
              {fieldsOnPage.map((field) => {
                const needsReview = pendingReviewIds.has(field.id);
                return (
                  <li key={field.id} className={`rounded-xl border p-2.5 ${selectedFieldId === field.id ? 'border-[var(--accent-rest)] ring-1 ring-ink-500' : needsReview ? 'border-amber-400' : 'border-[var(--border-hairline)]'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-xs font-bold ${needsReview ? 'text-[var(--status-caution-text)]' : 'text-[var(--text-secondary)]'}`}>{needsReview ? 'Suggested, review required' : 'Reviewed field'}</span>
                      {field.required && <span className="text-xs text-[var(--text-secondary)]">Required</span>}
                    </div>
                    <label className="mt-2 block text-xs font-semibold text-[var(--text-secondary)]">Name<input value={field.name} onFocus={() => setSelectedFieldId(field.id)} onChange={(event) => setFields((current) => current.map((item) => item.id === field.id ? { ...item, name: event.target.value } : item))} className="mt-1 h-11 w-full rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-transparent px-3 font-semibold text-[var(--text-primary)] outline-none focus:border-[var(--accent-rest)]" /></label>
                    <label className="mt-2 block text-xs font-semibold text-[var(--text-secondary)]">Type<select value={field.kind} onFocus={() => setSelectedFieldId(field.id)} onChange={(event) => setFields((current) => current.map((item) => item.id === field.id ? { ...item, kind: event.target.value as FillableFieldKind } : item))} className="mt-1 h-11 w-full rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 text-sm text-[var(--text-primary)]">{fieldKinds.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
                    <div className="mt-2 flex gap-2">
                      {needsReview && <button type="button" onClick={() => keepSuggestion(field.id)} className="chef-hit-y chef-pressable min-h-11 flex-1 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-3 text-sm font-bold text-[var(--text-on-accent)]">Keep</button>}
                      <button type="button" aria-label={`Delete ${field.name}`} onClick={() => removeField(field.id)} className="chef-hit-y chef-pressable flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--status-danger-text)] px-3 text-[var(--status-danger-text)] hover:bg-[var(--status-danger-quiet)]"><Trash2 size={18} /><span className="ml-2 text-sm font-bold">Delete</span></button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>
      <StatusToast status={status} />
    </div>
  );
};
