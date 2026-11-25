import { localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FormInput, ListChecks, Loader2, PenLine, ScanSearch, SlidersHorizontal, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { FileUpload } from '../UI/FileUpload';
import { PDFLoadingProgress } from '../UI/PDFLoadingProgress';
import { ToolScreen } from '../Tool/ToolScreen';
import { ChangeFile } from '../Tool/ToolTop';
import { Sentence } from '../Tool/Sentence';
import { StatusToast } from '../UI/StatusToast';
import { ActionRow, Notice, ResultSlot, useToolAnnounce } from '../Tool/parts';
import { Pop, openerProps, usePop } from '../Tool/Popover';
import { formatNumber } from '../../services/i18n/core.ts';
import { useWide } from '../../hooks/useMediaQuery';
import { useZoom } from '../../hooks/useZoom';
import { usePdfPinchZoom } from '../../hooks/usePdfPinchZoom';
import { ZoomControls } from '../UI/ZoomControls';
import { createFillablePdf, detectVisualFormFields, getPageSelectableTextLines, getPdfFormFields, getPdfPagePreviews, loadDisposablePDFDocument, loadPDFDocument, renderPageAsImage, type PdfPreviewProgress } from '../../services/pdfLazy';
import { type FillableFieldKind, type FillableFieldPlacement } from '../../services/fillableForms';
import { downloadBytes, revokeObjectUrls } from '../../services/pdfShared';
import { getWorkspaceSettings } from '../../services/workspace';
import { useHeavyJobCheck } from '../../hooks/useHeavyJobCheck';
import { useDiscardPrompt } from '../../hooks/useConfirmDiscard';
import type { ProcessingStatus } from '../../types';
import { toolOutputName } from '../UI/format';
import { useWorkInput } from '../UI/workSignature';

const fieldKinds: Array<{ value: FillableFieldKind; label: string }> = [
  { value: 'text', get label() { return t("make-fillable.text.71988c"); } },
  { value: 'multiline', get label() { return t("make-fillable.long.text.4448b9"); } },
  { value: 'checkbox', get label() { return t("make-fillable.checkbox.d103a1"); } },
  { value: 'radio', get label() { return t("make-fillable.radio.2a7dfe"); } },
  { value: 'dropdown', get label() { return t("make-fillable.dropdown.2c84dd"); } },
];

const makeId = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const validFieldName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export const MakeFillable: React.FC = () => {
  const { locale } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const wide = useWide();
  const [previews, setPreviews] = useState<string[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const heavy = useHeavyJobCheck();
  const [fields, setFields] = useState<FillableFieldPlacement[]>([]);
  // The fields the last export holds. Choose another file asks before other fields are lost (s4-01).
  const [exportedFields, setExportedFields] = useState<FillableFieldPlacement[] | null>(null);
  const discardPrompt = useDiscardPrompt();
  // The fields are the input of the result strip's file (workSignature.ts).
  useWorkInput(fields);
  const [kind, setKind] = useState<FillableFieldKind>('text');
  const [name, setName] = useState('');
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState('Option 1, Option 2');
  const [existingFieldCount, setExistingFieldCount] = useState(0);
  const [pendingReviewIds, setPendingReviewIds] = useState<Set<string>>(() => new Set());
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [touchDrawMode, setTouchDrawMode] = useState(false);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [preparingPreviews, setPreparingPreviews] = useState(false);
  const [previewProgress, setPreviewProgress] = useState<PdfPreviewProgress | null>(null);
  const previewControllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => { previewControllerRef.current?.abort(); }, []);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const newPop = usePop();
  const fieldsPop = usePop();

  useEffect(() => () => revokeObjectUrls(previews), [previews]);

  // Zoom (REVIEW.md item 6: a checkbox a few millimetres wide cannot be drawn at the fitted size):
  // Sign's − % + and two fingers on the page, from the fitted page (100%) to 400%. The page grows
  // from its fitted width; a fresh, sharper drawing replaces the small one while zoomed.
  const { zoom, zoomIn, zoomOut, resetZoom, setExactZoom } = useZoom(1, 1, 4, 0.5);
  const setPinchViewport = usePdfPinchZoom({ zoom, setZoom: setExactZoom, min: 1, max: 4 });
  const [fitWidth, setFitWidth] = useState(0);
  useLayoutEffect(() => {
    const node = previewRef.current;
    if (!node || zoom !== 1) return undefined;
    const measure = () => { const width = node.getBoundingClientRect().width; if (width > 0) setFitWidth(width); };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [zoom, pageIndex, previews, wide]);
  const [sharp, setSharp] = useState<{ index: number; url: string } | null>(null);
  const sharpRef = useRef(sharp);
  const zoomStep = Math.ceil(zoom);
  useEffect(() => {
    if (!file || zoomStep <= 1 || !fitWidth) return undefined;
    let alive = true;
    const timer = window.setTimeout(async () => {
      let pdf: any = null;
      try {
        pdf = await loadDisposablePDFDocument(file);
        const page = await pdf.getPage(pageIndex + 1);
        const width = page.getViewport({ scale: 1 }).width || 1;
        const scale = Math.min(4, Math.max(1, (fitWidth * zoomStep * Math.min(2, window.devicePixelRatio || 1)) / width));
        const { objectUrl } = await renderPageAsImage(pdf, pageIndex, { scale, format: 'image/jpeg', quality: 0.9 });
        if (!alive) { URL.revokeObjectURL(objectUrl); return; }
        if (sharpRef.current) URL.revokeObjectURL(sharpRef.current.url);
        sharpRef.current = { index: pageIndex, url: objectUrl };
        setSharp(sharpRef.current);
      } catch { /* the fitted drawing stays */ } finally {
        if (pdf?.destroy) void pdf.destroy();
      }
    }, 250);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [file, pageIndex, zoomStep, fitWidth]);
  useEffect(() => () => { if (sharpRef.current) URL.revokeObjectURL(sharpRef.current.url); }, []);
  useEffect(() => { resetZoom(); }, [file, resetZoom]);
  const pageSrc = zoom > 1 && sharp?.index === pageIndex ? sharp.url : previews[pageIndex];
  const setPageViewport = useCallback((node: HTMLDivElement | null) => setPinchViewport(node), [setPinchViewport]);
  const zoomControls = (
    <ZoomControls className="tk-fill-zoom" zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} min={1} max={4} />
  );

  const fieldsOnPage = useMemo(() => fields.filter((field) => field.pageIndex === pageIndex), [fields, pageIndex]);
  const pendingReviewCount = pendingReviewIds.size;
  const validationMessages = useMemo(() => {
    const messages: string[] = [];
    if (fields.length === 0) messages.push(t("make-fillable.add.at.least.one.field.before.creating.fcb524"));
    if (pendingReviewCount > 0) messages.push(t("make-fillable.keep.or.remove.the.suggested.field.still.2cb558", { count: pendingReviewCount }));
    if (fields.some((field) => !validFieldName.test(field.name))) messages.push(t("make-fillable.field.names.must.start.with.a.letter.ba8fe6"));
    if (new Set(fields.map((field) => field.name.toLowerCase())).size !== fields.length) messages.push(t("make-fillable.field.names.must.be.unique.564b3d"));
    if (fields.some((field) => {
      if (field.kind !== 'dropdown') return false;
      const choices = (field.options ?? []).map((option) => option.trim());
      return choices.length === 0 || choices.some((option) => !option) || new Set(choices).size !== choices.length;
    })) messages.push(t("make-fillable.dropdown.options.required"));
    return messages;
  }, [fields, pendingReviewCount, locale]);

  const announce = useToolAnnounce();
  const removeField = (id: string) => {
    const name = fields.find((field) => field.id === id)?.name;
    setFields((current) => current.filter((field) => field.id !== id));
    if (name) announce(t('tool.removed', { v0: name }));
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
    if (!selected || previewControllerRef.current || status.isProcessing) return;
    // Pages are drawn as soon as the file is chosen, so the heavy-job question comes here (fix round 2, item 7).
    if (!(await heavy.confirm(selected.size, t("make-fillable.this.is.a.large.pdf.and.may.848eab")))) return;
    setStatus({ isProcessing: true, progress: 10, message: t("make-fillable.preparing.pages.ebeefc") });
    const controller = new AbortController();
    previewControllerRef.current = controller;
    setPreparingPreviews(true);
    setPreviewProgress(null);
    let pdf: any = null;
    try {
      revokeObjectUrls(previews);
      pdf = await loadPDFDocument(selected);
      if (pdf?.isPureXfa) {
        throw new Error(t("make-fillable.this.form.was.built.with.a.special.5b8d56"));
      }
      const existingFields = await getPdfFormFields(pdf);
      const nextPreviews = await getPdfPagePreviews(selected, {
        scale: 0.8, signal: controller.signal,
        onProgress: progress => { if (!controller.signal.aborted) setPreviewProgress(progress); },
      });
      setFile(selected);
      setPreviews(nextPreviews);
      setFields([]);
      setPendingReviewIds(new Set());
      setSelectedFieldId(null);
      setTouchDrawMode(false);
      setExistingFieldCount(new Set(existingFields.map((field) => field.fieldName)).size);
      setPageIndex(0);
      setStatus({ isProcessing: false, progress: 100, message: t("make-fillable.ready.draw.the.boxes.yourself.or.let.c60493") });
    } catch (error) {
      if (controller.signal.aborted) return;
      setFile(null);
      setExistingFieldCount(0);
      setStatus({ isProcessing: false, progress: 0, message: '', error: error instanceof Error ? localizeError(error) : t("make-fillable.unable.to.open.this.pdf.9c2826") });
    } finally {
      previewControllerRef.current = null;
      setPreparingPreviews(false);
      if (pdf?.destroy) void pdf.destroy();
    }
  };

  const addField = (x: number, y: number, width: number, height: number) => {
    const isSquare = kind === 'checkbox' || kind === 'radio';
    // A box is square on the page, not in fractions: the page is taller than wide, so the same
    // fraction of each side was a tall rectangle (round 6, desktop-01). `aspect` is height / width.
    const rect = previewRef.current?.getBoundingClientRect();
    const aspect = rect && rect.width > 0 && rect.height > 0 ? rect.height / rect.width : 1;
    const side = Math.max(0.035, Math.min(width, height * aspect));
    const nextName = name.trim() || `${kind}_${fields.length + 1}`;
    const id = makeId();
    setFields((current) => [...current, {
      id,
      name: nextName,
      kind,
      pageIndex,
      x,
      y,
      width: isSquare ? Math.min(side, 1 - x) : Math.max(0.08, width),
      height: isSquare ? Math.min(side / aspect, 1 - y) : Math.max(0.025, height),
      required,
      options: kind === 'dropdown' ? options.split(',') : undefined,
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
    setStatus({ isProcessing: true, progress: 5, message: t("make-fillable.looking.for.places.a.box.should.go.7252d7") });
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
        setStatus({ isProcessing: true, progress: Math.round((index + 1) / pdf.numPages * 90), message: t("make-fillable.checking.labels.and.visible.field.shapes.on.df18c3", { v0: index + 1, v1: pdf.numPages }) });
      }
      setFields((current) => [...current, ...suggestions]);
      setPendingReviewIds((current) => {
        const next = new Set(current);
        suggestions.forEach((suggestion) => next.add(suggestion.id));
        return next;
      });
      setSelectedFieldId(suggestions[0]?.id ?? null);
      if (suggestions[0]) setPageIndex(suggestions[0].pageIndex);
      setStatus({ isProcessing: false, progress: 100, message: suggestions.length ? t("make-fillable.suggested.check.each.one.and.keep.or.8c1c0b", { count: suggestions.length }) : t("make-fillable.noPlacesFound") });
    } catch (error) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: error instanceof Error ? localizeError(error) : t("make-fillable.field.suggestions.failed.25903c") });
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
    setStatus({ isProcessing: true, progress: 20, message: t("make-fillable.adding.the.boxes.to.the.pdf.a8caa8") });
    try {
      const bytes = await createFillablePdf(file, fields);
      downloadBytes(bytes, toolOutputName('fillable', file.name, 'pdf'), 'application/pdf');
      setExportedFields(fields);
      // "Downloaded" only when the app saved it on its own; otherwise the file waits in the
      // result strip until Download is pressed (round 6, gpt-sol-01).
      setStatus({
        isProcessing: false,
        progress: 100,
        message: getWorkspaceSettings().autoDownload
          ? t("make-fillable.fillable.pdf.downloaded.with.reviewed.field.test.25220b", { count: fields.length })
          : t('make-fillable.ready.with.reviewed.fields', { count: fields.length }),
      });
    } catch (error) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: error instanceof Error ? localizeError(error) : t("make-fillable.unable.to.create.the.fillable.pdf.d1f600") });
    }
  };

  const title = t("make-fillable.make.fillable.04160a");

  if (!file) {
    return (
      <ToolScreen
        title={title}
        beta
        kind="file"
        body={(
          <div className="tk-empty">
            <FileUpload onFilesSelected={(files) => void select(files)} accept=".pdf,application/pdf" label={t("make-fillable.choose.a.pdf.to.make.fillable.2b865c")} />
            {preparingPreviews ? <PDFLoadingProgress progress={previewProgress} /> : null}
          </div>
        )}
        toast={preparingPreviews ? undefined : <StatusToast status={status} />}
        extra={heavy.sheet}
      />
    );
  }

  const clearFile = () => { revokeObjectUrls(previews); setFile(null); setPreviews([]); setFields([]); setPendingReviewIds(new Set()); setSelectedFieldId(null); setTouchDrawMode(false); setExistingFieldCount(0); };
  const chooseAnother = () => {
    if (fields.length > 0 && fields !== exportedFields) discardPrompt.ask(clearFile);
    else clearFile();
  };

  // Kept: detection is heuristic, and an unreviewed field ships in the export.
  const statement = (
    <Sentence
      template="make-fillable.suggestions.can.be.wrong.so.review.every.21f3d3"
      groupLabel={t('sentence.groupLabel', { tool: title })}
      disabled={status.isProcessing}
    />
  );
  const summaryText = t("make-fillable.message.8380c2f3dd", { v0: file.name, v3: pendingReviewCount > 0 ? t("make-fillable.to.review.2fe917", { v0: pendingReviewCount }) : '', count: fields.length });
  // One notice line (T-02): the job's status in place of the floating toast, else what still
  // blocks the export, else the field count. The opening "Ready. Draw the boxes…" is an
  // instruction: once a field exists it gives way to the count ("1 new field").
  const openingLine = status.message === t("make-fillable.ready.draw.the.boxes.yourself.or.let.c60493");
  const noticeLine = status.error
    ? <Notice tone="error" role="alert">{status.error}</Notice>
    : status.isProcessing
      ? <Notice tone="pending" role="status">{status.message}</Notice>
      : status.message && status.progress === 100 && !(openingLine && fields.length > 0)
        ? <Notice role="status">{status.message}</Notice>
        : validationMessages.length > 0
          ? <Notice tone="caution">{validationMessages[0]}</Notice>
          : <p className="tk-notice-line tk-fill-summary">{summaryText}</p>;
  const detectLabel = t("make-fillable.detect.fields.fb7a97");
  const detectButton = (
    <button type="button" onClick={() => void suggestFields()} disabled={status.isProcessing} className="tk-btn tk-btn-outline chef-pressable"><ScanSearch aria-hidden size={18} />{detectLabel}</button>
  );
  const createButton = (
    <button type="button" onClick={() => void exportPdf()} disabled={status.isProcessing || validationMessages.length > 0} aria-describedby="fillable-validation" className="tk-primary chef-pressable">{status.isProcessing ? <Loader2 aria-hidden className="animate-spin" size={18} /> : <FormInput aria-hidden size={18} />}{t("make-fillable.create.fillable.pdf.c0c37b")}</button>
  );

  // Today's review card. On a phone it is in the fields sheet; the line that blocks the export
  // is also the foot's notice line, so it is seen without opening anything.
  const reviewCard = (
    <div id="fillable-validation" aria-live="polite" className="rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] px-3 py-2.5 text-sm text-[var(--text-secondary)]">
      <p><strong>{t("make-fillable.review.first.c0b03c")}</strong>{t("make-fillable.every.detected.box.is.a.suggestion.until.5417cd")}</p>
      {existingFieldCount > 0 && <p className="mt-1">{t("make-fillable.message.35c4641a7c", { count: existingFieldCount })}</p>}
      {validationMessages.length > 0
        ? <ul className="mt-2 list-disc space-y-1 ps-5 text-[var(--status-caution-text)]">{validationMessages.map((message) => <li key={message}>{message}</li>)}</ul>
        : <p className="mt-2 font-semibold text-[var(--status-success-text)]">{t("make-fillable.all.new.fields.are.reviewed.and.ready.5aab83")}</p>}
    </div>
  );

  // "Drag on the page to place it…" is the Draw button's description now (T-14): the button
  // already offers the gesture, so the line under the form is gone.
  const drawLabel = touchDrawMode ? t("make-fillable.cancel.drawing.d0c990") : t("make-fillable.draw.field.on.page.4ca901");
  const drawButton = (
    <button type="button" aria-pressed={touchDrawMode} aria-describedby="fillable-draw-hint" onClick={() => setTouchDrawMode((current) => !current)} className={`tk-fill-draw chef-target chef-pressable w-full rounded-[var(--radius-control)] px-4 text-sm font-bold ${touchDrawMode ? 'bg-[var(--accent-rest)] text-[var(--text-on-accent)]' : 'border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text-primary)]'}`}>{drawLabel}</button>
  );
  const drawHint = <span id="fillable-draw-hint" className="sr-only">{t("make-fillable.drawHint")}</span>;

  const newFieldControls = (
    <>
      <label className="block text-sm font-semibold text-[var(--text-secondary)]">{t("make-fillable.type.baaddf")}<select value={kind} onChange={(event) => setKind(event.target.value as FillableFieldKind)} className="chef-field mt-1">{fieldKinds.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label className="block text-sm font-semibold text-[var(--text-secondary)]">{t("make-fillable.name.dcd1d5")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={`${kind}_${fields.length + 1}` /* the automatic name, in ASCII digits as saved (B-033) */} className="chef-field mt-1" /></label>
      {kind === 'dropdown' && <label className="block text-sm font-semibold text-[var(--text-secondary)]">{t("make-fillable.options.d0db8b")}<input value={options} onChange={(event) => setOptions(event.target.value)} className="chef-field mt-1" /></label>}
      <label className="flex min-h-touch items-center gap-2 text-sm font-semibold text-[var(--text-secondary)]"><input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} className="h-5 w-5 accent-[var(--accent-rest)]" />{t("make-fillable.required.d070b4")}</label>
    </>
  );

  const pageView = (
    <div
      ref={previewRef}
      className={`relative mx-auto w-fit max-w-full select-none overflow-hidden bg-white shadow-[var(--elevation-panel)] ${touchDrawMode ? 'touch-none' : 'touch-auto'}`}
      style={zoom > 1 && fitWidth ? { width: fitWidth * zoom, maxWidth: 'none' } : undefined}
      onPointerDown={(event) => {
        // A second finger is a pinch: the box being drawn is dropped, and drawing stays on.
        if (!event.isPrimary) { dragStart.current = null; return; }
        if (event.pointerType === 'touch' && !touchDrawMode) return;
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
      <img src={pageSrc} alt={t("make-fillable.page.c140ba", { v0: pageIndex + 1 })} className="tk-fill-img block max-w-full object-contain" style={zoom > 1 && fitWidth ? { width: '100%', maxWidth: 'none', maxHeight: 'none' } : undefined} draggable={false} />
      {fieldsOnPage.map((field) => (
        <button
          key={field.id}
          type="button"
          title={t("make-fillable..9ff7a1", { v0: fieldKinds.find(item => item.value === field.kind)?.label ?? field.kind, v1: field.name })}
          aria-label={t("make-fillable.field.e98bed", { v0: pendingReviewIds.has(field.id) ? t("make-fillable.suggested.93b63b") : t("make-fillable.reviewed.fad605"), v1: fieldKinds.find(item => item.value === field.kind)?.label ?? field.kind, v2: field.name })}
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
          <span className={`absolute left-0 top-0 max-w-full truncate rounded px-1.5 py-0.5 text-white ${pendingReviewIds.has(field.id) ? 'bg-amber-700' : 'bg-blue-700'}`}>{pendingReviewIds.has(field.id) ? t("make-fillable.review.2a60e2") : ''}{field.name}</span>
        </button>
      ))}
    </div>
  );

  // Phone: chevrons named Previous and Next; desktop: today's words.
  const pager = (
    <nav aria-label={t("make-fillable.pdf.pages.5b5a81")} className="tk-fill-pager">
      <button type="button" onClick={() => goToPage(pageIndex - 1)} disabled={pageIndex === 0} aria-label={wide ? undefined : t("make-fillable.previous.a57b08")} className={wide ? 'chef-target chef-pressable shrink-0 whitespace-nowrap rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 text-sm font-bold text-[var(--text-primary)] disabled:opacity-55' : 'tk-iconbtn chef-pressable'}>{wide ? t("make-fillable.previous.a57b08") : <ChevronLeft aria-hidden size={20} className="rtl:rotate-180" />}</button>
      <span className={`tabular text-center text-sm font-bold text-[var(--text-body)] ${wide ? 'min-w-0 flex-1 basis-24' : 'px-1'}`}>{t("make-fillable.message.477c22095a", { v0: pageIndex + 1, v1: previews.length })}</span>
      <button type="button" onClick={() => goToPage(pageIndex + 1)} disabled={pageIndex >= previews.length - 1} aria-label={wide ? undefined : t("make-fillable.next.1ff57a")} className={wide ? 'chef-target chef-pressable shrink-0 whitespace-nowrap rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 text-sm font-bold text-[var(--text-primary)] disabled:opacity-55' : 'tk-iconbtn chef-pressable'}>{wide ? t("make-fillable.next.1ff57a") : <ChevronRight aria-hidden size={20} className="rtl:rotate-180" />}</button>
    </nav>
  );

  const fieldsHeading = t("make-fillable.message.c517d2ca8e", { v0: pageIndex + 1 });
  const fieldList = fieldsOnPage.length === 0 ? <p className="mt-2 text-sm text-[var(--text-secondary)]">{t("make-fillable.noBoxesOnPage")}</p> : (
    <ul className="mt-2 space-y-2">
      {fieldsOnPage.map((field) => {
        const needsReview = pendingReviewIds.has(field.id);
        return (
          <li key={field.id} className={`rounded-xl border p-2.5 ${selectedFieldId === field.id ? 'border-[var(--accent-rest)] ring-1 ring-ink-500' : needsReview ? 'border-amber-400' : 'border-[var(--border-hairline)]'}`}>
            <div className="flex items-center justify-between gap-2">
              <span className={`text-xs font-bold ${needsReview ? 'text-[var(--status-caution-text)]' : 'text-[var(--text-secondary)]'}`}>{needsReview ? t("make-fillable.suggested.review.required.db3ee4") : t("make-fillable.reviewed.field.26721c")}</span>
              {field.required && <span className="text-xs text-[var(--text-secondary)]">{t("make-fillable.required.4850b1")}</span>}
            </div>
            <label className="mt-2 block text-xs font-semibold text-[var(--text-secondary)]">{t("make-fillable.name.dcd1d5")}<input value={field.name} onFocus={() => setSelectedFieldId(field.id)} onChange={(event) => setFields((current) => current.map((item) => item.id === field.id ? { ...item, name: event.target.value } : item))} className="mt-1 h-11 w-full rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-transparent px-3 font-semibold text-[var(--text-primary)] outline-none focus:border-[var(--accent-rest)]" /></label>
            <label className="mt-2 block text-xs font-semibold text-[var(--text-secondary)]">{t("make-fillable.type.baaddf")}<select value={field.kind} onFocus={() => setSelectedFieldId(field.id)} onChange={(event) => setFields((current) => current.map((item) => item.id === field.id ? { ...item, kind: event.target.value as FillableFieldKind } : item))} className="mt-1 h-11 w-full rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 text-sm text-[var(--text-primary)]">{fieldKinds.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
            {field.kind === 'dropdown' && <label className="mt-2 block text-xs font-semibold text-[var(--text-secondary)]">{t("make-fillable.options.d0db8b")}<input value={(field.options ?? []).join(',')} onFocus={() => setSelectedFieldId(field.id)} onChange={(event) => setFields((current) => current.map((item) => item.id === field.id ? { ...item, options: event.target.value.split(',') } : item))} className="chef-field mt-1" /></label>}
            <div className="mt-2 flex gap-2">
              {needsReview && <button type="button" onClick={() => keepSuggestion(field.id)} className="chef-hit-y chef-pressable min-h-11 flex-1 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-3 text-sm font-bold text-[var(--text-on-accent)]">{t("make-fillable.keep.183f00")}</button>}
              <button type="button" aria-label={t("make-fillable.delete.3468c7", { v0: field.name })} onClick={() => removeField(field.id)} className="chef-hit-y chef-pressable flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--status-danger-text)] px-3 text-[var(--status-danger-text)] hover:bg-[var(--status-danger-quiet)]"><Trash2 size={18} /><span className="ml-2 text-sm font-bold">{t("make-fillable.delete.e2d0a5")}</span></button>
            </div>
          </li>
        );
      })}
    </ul>
  );

  const body = wide ? (
    <div className="tk-editor tk-fill">
      <div className="tk-editor-band">
        <div className="tk-editor-band-main">
          {statement}
          {noticeLine}
        </div>
        <div className="tk-editor-band-end">
          <ActionRow>{detectButton}{createButton}</ActionRow>
          <ResultSlot />
        </div>
      </div>
      <div className="tk-fill-scroll">
      {reviewCard}
      <div className="tk-fill-grid grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)_310px]">
        <aside aria-label={t("make-fillable.new.field.settings.a41176")} className="order-1 flex h-fit flex-col gap-3 rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 lg:order-none">
          <h2 className="font-bold text-[var(--text-primary)]">{t("make-fillable.new.field.a3469d")}</h2>
          {newFieldControls}
          {drawButton}
          {drawHint}
        </aside>
        <div className="tk-fill-pagecol order-2 min-w-0 overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)] p-3 lg:order-none">
          {/* The page fits the room the column has, so the pager under it stays on the screen
              (round 6, desktop-07: at 1024×768 it was below the fold). */}
          <div ref={setPageViewport} className="tk-fill-pagebox chef-scroller">{pageView}</div>
          <div className="tk-fill-navrow">{pager}{zoomControls}</div>
        </div>
        <aside className="chef-scroller order-3 h-fit max-h-[78vh] overflow-auto rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-3 lg:order-none">
          <h2 className="font-bold text-[var(--text-primary)]">{fieldsHeading}</h2>
          {fieldList}
        </aside>
      </div>
      </div>
    </div>
  ) : (
    // Phone (T-02): the page first under one toolbar (pages and the page's fields), the creation
    // tools and the main action at the foot, and the field form, the review card and the field
    // list in foot sheets. Same controls and names as before.
    <div className="tk-editor tk-fill tk-fill-phone">
      {/* First in the document so the actions come before the page, drawn at the foot (verify V-01). */}
      <div className="tk-footbar tk-fill-foot">
        <ResultSlot />
        {noticeLine}
        {/* The creation tools as one row of tabs, as in Edit PDF's foot bar. */}
        <div className="tk-foot-tabs">
          {/* A toggle with one name: the short word "Draw" shows, aria-pressed tells whether drawing is on. */}
          <button type="button" aria-pressed={touchDrawMode} aria-label={t("make-fillable.draw.field.on.page.4ca901")} aria-describedby="fillable-draw-hint" onClick={() => setTouchDrawMode((current) => !current)} className="tk-foot-tab chef-pressable">
            <PenLine aria-hidden size={18} /><span>{t("sign-pdf.draw.61517c")}</span>
          </button>
          <button {...openerProps(newPop, 'fillable-new-field', 'new')} className="tk-foot-tab chef-pressable">
            <SlidersHorizontal aria-hidden size={18} /><span>{t("make-fillable.new.field.a3469d")}</span>
          </button>
          <button type="button" onClick={() => void suggestFields()} disabled={status.isProcessing} className="tk-foot-tab chef-pressable">
            <ScanSearch aria-hidden size={18} /><span>{detectLabel}</span>
          </button>
        </div>
        <div className="tk-actions">{createButton}</div>
      </div>
      <div className="tk-fill-toolbar">
        {pager}
        <button {...openerProps(fieldsPop, 'fillable-fields', 'fields')} className="tk-chip chef-pressable">
          <ListChecks aria-hidden size={16} className="shrink-0" /><span className="truncate">{fieldsHeading}</span>
          {fieldsOnPage.length > 0 && <span className="tabular shrink-0">{` · ${formatNumber(fieldsOnPage.length)}`}</span>}
        </button>
      </div>
      {/* Sign's page frame: − % + at the top end, outside the page at rest (pass 5). */}
      <div className="tk-fill-stagebox">
        <div ref={setPageViewport} className="tk-fill-stage">{pageView}</div>
        {zoomControls}
      </div>
      {drawHint}
      {/* Light: the page stays undimmed, and a drag on it closes the sheet and draws (h1-03). */}
      <Pop pop={newPop} id="fillable-new-field" title={t("make-fillable.new.field.a3469d")} quiet>
        <div aria-label={t("make-fillable.new.field.settings.a41176")} role="group" className="flex flex-col gap-3">{newFieldControls}</div>
      </Pop>
      <Pop pop={fieldsPop} id="fillable-fields" title={fieldsHeading}>
        {/* The review card says it once (review 2, item 11). */}
        {reviewCard}
        {fieldList}
      </Pop>
    </div>
  );

  return (
    <ToolScreen
      title={title}
      beta
      kind="editor"
      file={{ name: file.name }}
      change={<ChangeFile label={t('tool.chooseAnotherFile')} onClick={chooseAnother} />}
      body={body}
      extra={discardPrompt.sheet}
    />
  );
};
