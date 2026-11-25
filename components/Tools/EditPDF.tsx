import { localizeError } from '../../services/i18n/errors.ts';
import english from '../../services/i18n/en-US.ts';
import { t, getLocale, formatNumber } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';

import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import {
  getPageTextBackgroundPatch,
  getPdfFormFields,
  loadEditablePDFDocument,
  savePDFWithAnnotations,
  type PdfFormFieldDefinition,
  type PdfFormFieldValue,
} from '../../services/pdfLazy';
import type { EditorElement, ParagraphFace, ParagraphSaveEdit } from '../../services/pdfDocument';
import { getPageTextBlocks, resolvePageFonts, type PageTextBlocks } from '../../services/pdfBlockExtraction';
import { findRefusingItems } from '../../services/findRefusingItems';
import { serializeEditorState } from '../../services/pdfEditorSnapshot';
import { getPdfRenderScale } from '../../services/pdfPageGeometry';
import { layoutParagraphLines, measureParagraphText, paragraphLineOrigins } from '../../services/pdfParagraphLayout';
import {
  documentEmbeddedFontsReady,
  embeddedPdfFont,
  loadDocumentEmbeddedFonts,
  matchingSimpleEmbeddedPdfFont,
  releaseDocumentEmbeddedFonts,
} from '../../services/pdfEmbeddedFonts';
import {
  canShapeDevanagari,
  devanagariCssFamily,
  devanagariFontsReady,
  documentDevanagariFontsReady,
  hasDevanagari,
  loadDevanagariFonts,
  loadDocumentDevanagariFonts,
  measureDevanagariText,
  selectDevanagariFont,
  type DevanagariFontId,
} from '../../services/pdfDevanagari';
import type { PdfTextBlock } from '../../services/pdfTextBlocks';
import {
  blockStyledSegments,
  carrySoftBreaks,
  flowStyledLines,
  styledTextEqual,
  findInStyledLines,
  planBlockEdit,
  replaceInStyledLines,
  segmentInks,
  splitByInk,
  styledLineText,
  withoutInks,
  type BlockEditPlan,
  type StyledMatch,
  type StyledSegment,
} from '../../services/pdfBlockEditPlanning';
import {
  checkGlyphCoverage,
  describeCharacters,
  measureTextWidth,
  resetFontResolutionCaches,
  resolveFont,
  unencodableCharacters,
  type PdfFontDescriptor,
} from '../../services/pdfFontResolution';
import {
  PdfTextBlockLayer,
  samplePageBlockColors,
  blockRange,
  clearFindHighlights,
  hasParagraphRestyle,
  paintFindHighlights,
  scrollBlockIntoViewport,
  useKeyboardSafeFocus,
  type BlockColors,
  type BlockEditState,
  type BlockTextPreview,
} from './PdfTextBlockLayer';
import { PdfFindReplace } from './PdfFindReplace';
import { PdfParagraphInspector } from './PdfParagraphInspector';
import { PdfParagraphField } from './PdfParagraphField';
import { PdfElementDock } from './PdfElementDock';
import { deliverBlob } from '../../services/pdfShared';
import { normalizeImageFileWithSize } from '../../services/imageBrowser';
import { ArrowRight, ChevronLeft, ChevronRight, Circle, ImagePlus, Minus, Move, Redo2, Save, Search, Shapes, Square, Trash2, Type, Undo2, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { StatusLine } from '../UI/Primitives';
import { ToolLeaveGuard, ToolScreen } from '../Tool/ToolScreen';
import { ToolTop, useRouteTool } from '../Tool/ToolTop';
import { ResultSlot, useAnnouncer } from '../Tool/parts';
import { v4 as uuidv4 } from 'uuid';
import { Link } from 'react-router-dom';
import { ZoomControls } from '../UI/ZoomControls';
import { ClampedNumberInput } from '../UI/ClampedNumberInput';
import { useZoom } from '../../hooks/useZoom';
import { useDiscardPrompt, useLeaveGuarded } from '../../hooks/useConfirmDiscard';
import { useWorkInput } from '../UI/workSignature';
import { useFileDrop } from '../../hooks/useFileDrop';
import { usePdfPinchZoom } from '../../hooks/usePdfPinchZoom';
import { MQ_LG, useMediaQuery } from '../../hooks/useMediaQuery';
import { useShellOwnChrome } from '../Layout/AppShell';
import { PDF_TEXT_OVERFLOW_MESSAGE } from '../../services/pdfTextEditSafety';
import { layoutTextBox, PdfTextBoxError, TEXT_BOX_PADDING_X, TEXT_BOX_PADDING_Y } from '../../services/pdfTextBoxLayout';
import { pdfPageFromScrollBoundary, pdfPageFromSwipe } from '../../services/pdfZoomGesture';
import { releaseNativePdfTextDocument } from '../../services/pdfNativeTextEditor';
import { dismissOutputBanner } from '../../services/workspace';
import { toolOutputName } from '../UI/format';

const elementAction = (kind: EditorElement['type'], action: 'add' | 'choose' | 'properties' | 'selected') => t(`editor.${kind}.${action}`);
const elementAnnouncement = (kind: EditorElement['type'], selected: boolean, page: number) =>
  t(`editor.${kind}.${selected ? 'selectedAria' : 'aria'}`, { page });
const elementAdded = (kind: EditorElement['type'], page: number) => t(`editor.${kind}.added`, { page });
const MOVED_KEYS = { ArrowLeft: 'edit.moved.left', ArrowRight: 'edit.moved.right', ArrowUp: 'edit.moved.up', ArrowDown: 'edit.moved.down' } as const;

/**
 * Edit PDF's polite line, for what the page's own elements do (a box moved with the arrow keys):
 * they are drawn inside the page, below the screen that owns the line (path to 9, part 2).
 */
let editAnnounce: ((words: string) => void) | null = null;

const DISCARD_EDITS_MESSAGE = english["edit-pdf.discard.your.unsaved.edits.1575c6"];
const editorCssFontFamily = (fontFamily: string | undefined) => (
  fontFamily === 'TimesRoman'
    ? 'Times New Roman'
    : fontFamily === 'Courier'
      ? 'Courier New'
      : 'Arial'
);

interface EditorSnapshot {
  elements: EditorElement[];
  blockEdits: Record<string, BlockEditState>;
  formValues: Record<string, PdfFormFieldValue>;
}

/** Touch input needs bigger targets and cannot rely on hover to reveal anything. */
const useCoarsePointer = () => {
  const [coarse, setCoarse] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  ));

  useEffect(() => {
    const media = window.matchMedia('(pointer: coarse)');
    const update = () => setCoarse(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return coarse;
};

/** Below this, mobile browsers zoom the whole page the moment an editable element takes focus. */
const MINIMUM_EDITING_FONT_PX = 16;
/** Tapping a paragraph never leaves its text smaller than this on screen. */
const LEGIBLE_EDITING_FONT_PX = 10;
/** Comfortable target for a finger, in CSS pixels. Both platforms' guidance lands here. */
const TOUCH_TARGET_PX = 44;
/**
 * Touch region for a PDF's own form fields.
 *
 * Deliberately the 24px floor rather than the 44px a standalone control gets. A form field is an
 * inline target sitting among the words that label it, and reaching all the way to 44 was measured
 * taking roughly one paragraph tap in seven on a dense tax form. 24 still recovers the near misses
 * that a checkbox a few pixels across otherwise swallows, without reaching into the text beside it.
 */
const FIELD_TOUCH_TARGET_PX = 24;
/** iPhone, iPad, or the iOS app, where the dock field is not used yet (see `dockEditing`). */
const APPLE_TOUCH = Capacitor.getPlatform() === 'ios' || (typeof navigator !== 'undefined'
  && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)));
const EDITOR_MAX_ZOOM = 4;
/** PDF permission flag for "modify contents", as PDF.js reports it. */
const PDF_PERMISSION_MODIFY_CONTENTS = 8;
/** The PDF engine's own refusals, which a save can work around paragraph by paragraph. */
const isDirectEditFailure = (error: unknown): error is Error => (
  error instanceof Error && error.message.startsWith('Direct text edit failed:')
);
/** How long after the last keystroke the paragraph's save plan is worked out. */
const PLAN_SETTLE_MS = 180;

/**
 * Say which paragraphs cannot be changed, and what to do instead.
 *
 * The page numbers stay because on a long document they are the only way to find the paragraphs
 * again. Why the file will not take them does not: the reasons are about font encodings and text
 * objects, which tell a reader nothing they can act on. What they can act on is a text box, so
 * that is what the sentence ends with. The reason is still written to the console for support.
 */
const describeBlockedParagraphs = (
  blocked: Array<{ block: { pageIndex: number }; plan: { mode: string; reason?: string } }>,
) => {
  const pages = [...new Set(blocked.map(({ block }) => block.pageIndex + 1))]
    .sort((first, second) => first - second);
  const where = pages.length === 1
    ? t("edit-pdf.on.page.4378c3", { v0: pages[0] })
    : pages.length <= 4
      ? t("edit-pdf.on.pages.and.6b90f7", { v0: pages.slice(0, -1).join(', '), v1: pages[pages.length - 1] })
      : t("edit-pdf.on.pages.starting.at.page.19e0f0", { v0: pages.length, v1: pages[0] });

  return blocked.length === 1
    ? t("edit-pdf.this.paragraph.cannot.be.changed.add.a.7395b4", { v0: where })
    : t("edit-pdf.paragraphs.cannot.be.changed.add.text.boxes.8c54bf", { v0: blocked.length.toLocaleString(getLocale()), v1: where });
};

/** A refusal the editor chose to make, rather than a fault: an answer, not an error. */
const refusal = (message: string) => Object.assign(new Error(message), { name: 'PdfChefRefusal' });

/** Used only when a run carries no font information at all, which real PDFs rarely do. */
const FALLBACK_RESOLVED_FONT = {
  mode: 'substituted' as const,
  cssFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  cssWeight: '400',
  cssStyle: 'normal',
  klass: 'sans-serif' as const,
  reason: null,
  missingGlyphs: [] as string[],
};

const useCompactEditorViewport = () => {
  const [compact, setCompact] = useState(() => (
    typeof window !== 'undefined' && !window.matchMedia(MQ_LG).matches
  ));

  useEffect(() => {
    const media = window.matchMedia(MQ_LG);
    const update = () => setCompact(!media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return compact;
};

// --- REUSABLE PAGE COMPONENT ---
const PDFPage: React.FC<{
  pageIndex: number;
  pageCount: number;
  pdfDoc: any;
  elements: EditorElement[];
  formFields: PdfFormFieldDefinition[];
  formValues: Record<string, PdfFormFieldValue>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onUpdate: (id: string, updates: Partial<EditorElement>) => void;
  onBeginElementChange: () => void;
  onDelete: (id: string) => void;
  onFormValueChange: (fieldName: string, value: PdfFormFieldValue) => void;
  onPagePress: (position: { x: number; y: number }) => void;
  blockEdits: Record<string, BlockEditState>;
  blockPreviews: Record<string, BlockTextPreview>;
  activeBlockId: string | null;
  coarsePointer: boolean;
  cachedText?: (pageIndex: number) => PageTextBlocks | undefined;
  onBlocksReady: (pageIndex: number, blocks: PageTextBlocks, colors: Record<string, BlockColors>) => void;
  onActivateBlock: (blockId: string | null) => void;
  onBlockChange: (blockId: string, text: string) => void;
  onBeginBlockChange: (blockId: string) => void;
  insertMode: 'text' | 'shape' | null;
  placementLabel: string;
  zoom: number;
}> = ({
  pageIndex,
  pageCount,
  pdfDoc,
  elements,
  formFields,
  formValues,
  selectedId,
  onSelect,
  onUpdate,
  onBeginElementChange,
  onDelete,
  onFormValueChange,
  onPagePress,
  blockEdits,
  blockPreviews,
  activeBlockId,
  coarsePointer,
  cachedText,
  onBlocksReady,
  onActivateBlock,
  onBlockChange,
  onBeginBlockChange,
  insertMode,
  placementLabel,
  zoom,
}) => {
  useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  // A press that started on a placed element. On a touch screen the tap that selects a text box
  // swaps its preview for the editing box under the finger, so the browser sends the click to
  // the page, which cleared the selection again (round 6, mobile-01). Reset by every new press.
  const elementPressRef = useRef(false);
  const [isVisible, setIsVisible] = useState(false);
  const [isRendered, setIsRendered] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(600);
  const [textBlocks, setTextBlocks] = useState<PdfTextBlock[]>([]);
  const [blockFonts, setBlockFonts] = useState<PageTextBlocks['fonts']>(() => new Map());
  const [blockColors, setBlockColors] = useState<Record<string, BlockColors>>({});
  // Base dimensions at scale 1.0 (PDF Points)
  const [dims, setDims] = useState({ w: 600, h: 850 });
  const [pageUserUnit, setPageUserUnit] = useState(1);

  useEffect(() => {
    const obs = new IntersectionObserver(([entry]) => {
       if (entry.isIntersecting) setIsVisible(true);
    }, { rootMargin: '500px' }); // Larger preload margin for smooth zooming
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const parent = pageRef.current?.parentElement;
    if (!parent) return;
    const updateWidth = () => {
      const styles = window.getComputedStyle(parent);
      const horizontalPadding = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight);
      setAvailableWidth(Math.max(1, parent.clientWidth - horizontalPadding));
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;

    const render = async () => {
      if (!isVisible || isRendered || !pdfDoc || !canvasRef.current) return;
      // A page that has already been read — by an earlier visit, or by a whole-document search —
      // does not need its text extracted, its fonts described or its colours sampled again.
      const cachedPageText = cachedText?.(pageIndex);
      try {
        const page = await pdfDoc.getPage(pageIndex + 1);
        // Render at a high scale (2.0 unless the page is poster-sized) for sharpness when zooming in
        // We do NOT re-render on zoom change, we just scale the CSS
        const renderScale = getPdfRenderScale(page);
        const viewport = page.getViewport({ scale: renderScale });
        
        // Store logical dimensions (1.0 scale) for layout
        setDims({ w: viewport.width / renderScale, h: viewport.height / renderScale });
        setPageUserUnit(page.userUnit || 1);
        
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        renderTask = page.render({ canvasContext: ctx, viewport });
        await renderTask.promise;
        renderTask = null;
        if (cancelled) return;
        try {
          const pageText = cachedPageText ?? await getPageTextBlocks(pdfDoc, pageIndex, { readFonts: true });
          if (cancelled) return;
          setTextBlocks(pageText.blocks);
          setBlockFonts(pageText.fonts);
          // Sampled from the page that was just drawn, so the caret and any repaint match the
          // document's real ink and paper rather than an assumed black on white.
          const colors = samplePageBlockColors(canvas, pageText.blocks, renderScale);
          setBlockColors(colors);
          onBlocksReady(pageIndex, pageText, colors);
          // PDF.js keeps everything it parsed for this page until asked not to; the editor holds
          // the blocks it needs, so the rest can go.
          try {
            page.cleanup();
          } catch {
            // A page with nothing cached is already where this wants it.
          }
        } catch (error) {
          if (cancelled) return;
          // Losing the paragraphs turns the editor into a viewer with no explanation on screen, so
          // the reason belongs somewhere it can be found rather than being dropped on the floor.
          console.error('Paragraph extraction failed for page', pageIndex + 1, error);
          setTextBlocks([]);
          setBlockFonts(new Map());
        }
        // Marked done last: this is what closes the effect, and its own re-run would otherwise
        // cancel the extraction that had not finished yet.
        setIsRendered(true);
      } catch (error) {
        // A render that was deliberately stopped is not a failure worth reporting.
        if (!cancelled && (error as { name?: string })?.name !== 'RenderingCancelledException') {
          console.error(error);
        }
      }
    };
    render();

    // Leaving the page, or the editor, while it is still drawing must stop the draw rather than
    // let it finish into a canvas that is on its way out.
    return () => {
      cancelled = true;
      // Cancelling is best effort: a task that has already finished drawing has nothing left to
      // stop, and asking it to stop anyway is what throws.
      try {
        renderTask?.cancel();
      } catch {
        // Nothing to do: the draw is already over.
      }
    };
  }, [isVisible, isRendered, pdfDoc]);

  // Scaled dimensions for the wrapper
  // Treat 100% as fit-to-width on a phone. Intentional zooming stays inside the editor viewport,
  // so it never creates a horizontal scrollbar on the app page itself.
  const fitScale = Math.min(1, availableWidth / dims.w);
  const displayScale = fitScale * zoom;
  const scaledW = dims.w * displayScale;
  const scaledH = dims.h * displayScale;
  const fieldHitAreas = useFormFieldHitAreas(formFields, displayScale);
  return (
    <div 
      ref={pageRef}
      data-pdf-page={pageIndex}
      dir="ltr"
      role="group"
      className="relative mx-auto shrink-0 bg-white shadow-lg"
      style={{ width: scaledW, height: scaledH }} // Helper wrapper for layout flow
      onPointerDownCapture={() => { elementPressRef.current = false; }}
      onClick={(event) => {
        if (elementPressRef.current) {
          elementPressRef.current = false;
          return;
        }
        const bounds = event.currentTarget.getBoundingClientRect();
        onPagePress({
          x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
          y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
        });
      }}
      aria-label={t("edit-pdf.page.of.477c22", { v0: pageIndex + 1, v1: pageCount })}
    >
      <div 
        ref={containerRef}
        className="relative origin-top-left bg-white"
        style={{ 
          width: dims.w, 
          height: dims.h, 
          transform: `scale(${displayScale})`,
          // Ensure visual quality when scaling
          willChange: 'transform'
        }}
      >
        <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none w-full h-full" />
        <PdfTextBlockLayer
          blocks={textBlocks}
          fonts={blockFonts}
          edits={blockEdits}
          previews={blockPreviews}
          colors={blockColors}
          activeBlockId={activeBlockId}
          displayScale={1}
          enabled={!insertMode}
          coarsePointer={coarsePointer}
          onActivate={onActivateBlock}
          onChange={onBlockChange}
          onBeginChange={onBeginBlockChange}
        />
        {formFields.map((field) => (
          <PDFFormFieldControl
            key={field.id}
            field={field}
            hitArea={fieldHitAreas.get(field.id)}
            value={formValues[field.fieldName]}
            onChange={(value) => onFormValueChange(field.fieldName, value)}
            onActivate={() => onSelect(null)}
          />
        ))}
        {elements.map(el => (
          <ResizableElement 
            key={el.id} element={el} containerRef={containerRef}
            displayScale={displayScale}
            pageSize={{ width: dims.w / pageUserUnit, height: dims.h / pageUserUnit }}
            pageUserUnit={pageUserUnit}
            isSelected={selectedId === el.id}
            onSelect={() => { elementPressRef.current = true; onSelect(el.id); }}
            onUpdate={onUpdate} onDelete={onDelete} onBeginChange={onBeginElementChange}
          />
        ))}
        {insertMode && (
          <button
            type="button"
            data-testid="pdf-placement-target"
            aria-label={placementLabel}
            className="absolute inset-0 z-[500] h-full w-full cursor-crosshair border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-rest)]"
            style={{ touchAction: 'pan-x pan-y pinch-zoom' }}
            onClick={(event) => {
              event.stopPropagation();
              if (event.detail === 0) {
                onPagePress({ x: 0.1, y: 0.1 });
                return;
              }
              const bounds = event.currentTarget.getBoundingClientRect();
              onPagePress({
                x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
                y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
              });
            }}
          />
        )}
      </div>
    </div>
  );
};

const buildInitialFormValues = (fields: PdfFormFieldDefinition[]) => {
  const nextValues: Record<string, PdfFormFieldValue> = {};

  fields.forEach((field) => {
    const hasExistingValue = Object.prototype.hasOwnProperty.call(nextValues, field.fieldName);

    if (field.kind === 'radio') {
      if (!hasExistingValue || (typeof field.value === 'string' && field.value)) {
        nextValues[field.fieldName] = typeof field.value === 'string' ? field.value : '';
      }
      return;
    }

    if (!hasExistingValue) {
      nextValues[field.fieldName] = field.value;
    }
  });

  return nextValues;
};

/**
 * How much bigger than its own box each form field may answer a finger.
 *
 * A field is drawn at the size the form's author chose, which on a tax form is a checkbox a few
 * pixels across — far below anything a hand can hit reliably, and the reason filling one in on a
 * phone means pinching in first. The box itself cannot grow without leaving the printed page, so
 * the region that responds to touch grows instead.
 *
 * The cap is what makes that safe. Expanding a field by the whole gap to its neighbour adds half
 * of it on each side, so two adjacent fields meet exactly and neither can take a tap meant for the
 * other. Fields with room around them reach the full touch target; fields packed together grow as
 * far as the packing allows and no further.
 */
const useFormFieldHitAreas = (
  fields: PdfFormFieldDefinition[],
  displayScale: number,
) => useMemo(() => {
  // The page is drawn inside a scale transform, so the touch target is converted into the
  // unscaled space the field geometry is expressed in.
  const target = FIELD_TOUCH_TARGET_PX / Math.max(displayScale, 0.1);
  const areas = new Map<string, { width: number; height: number }>();

  fields.forEach((field) => {
    let gapX = Number.POSITIVE_INFINITY;
    let gapY = Number.POSITIVE_INFINITY;
    fields.forEach((other) => {
      if (other.id === field.id) return;
      const sharedRows = Math.min(field.y + field.height, other.y + other.height) - Math.max(field.y, other.y);
      const sharedColumns = Math.min(field.x + field.width, other.x + other.width) - Math.max(field.x, other.x);
      if (sharedRows > 0) {
        gapX = Math.min(gapX, other.x >= field.x + field.width
          ? other.x - (field.x + field.width)
          : field.x >= other.x + other.width
            ? field.x - (other.x + other.width)
            : 0);
      }
      if (sharedColumns > 0) {
        gapY = Math.min(gapY, other.y >= field.y + field.height
          ? other.y - (field.y + field.height)
          : field.y >= other.y + other.height
            ? field.y - (other.y + other.height)
            : 0);
      }
    });
    areas.set(field.id, {
      width: Math.min(target, field.width + Math.max(0, gapX)),
      height: Math.min(target, field.height + Math.max(0, gapY)),
    });
  });

  return areas;
}, [displayScale, fields]);

const PDFFormFieldControl: React.FC<{
  field: PdfFormFieldDefinition;
  /** Touch region for this field, already capped so it cannot reach a neighbour. */
  hitArea?: { width: number; height: number };
  value: PdfFormFieldValue | undefined;
  onChange: (value: PdfFormFieldValue) => void;
  onActivate: () => void;
}> = ({ field, hitArea, value, onChange, onActivate }) => {
  useI18n();
  const rawFontSize = Math.max(11, Math.min(16, field.height * 0.55));
  /**
   * Ratio that lifts this field's *computed* font size to the 16px iOS insists on.
   *
   * A form's boxes are small, so the text inside them is small, and iOS reads that computed size
   * before deciding to zoom the whole page to a focused input. It was doing exactly that: tapping
   * the name box on a W-4 magnified the page and carried Save off the right-hand edge. The field is
   * laid out in units this much larger and scaled back by the same amount — a change of units and
   * nothing else, so the box still sits where the form drew it.
   */
  const iosZoomGuard = Math.max(1, MINIMUM_EDITING_FONT_PX / rawFontSize);
  const unit = (length: number) => length * iosZoomGuard;
  const fontSize = unit(rawFontSize);
  // Applied to the control itself rather than a wrapper, so a tap inside the extended region lands
  // on the input and toggles or focuses it the way the platform already knows how. In the same
  // enlarged units as the box, so it still measures what it should once the scale is applied.
  const hit = hitArea
    ? {
      className: 'chef-field-hit',
      style: {
        '--chef-field-hit-w': `${Math.round(unit(hitArea.width))}px`,
        '--chef-field-hit-h': `${Math.round(unit(hitArea.height))}px`,
      } as React.CSSProperties,
    }
    : { className: '', style: {} as React.CSSProperties };
  const baseStyle: React.CSSProperties = {
    position: 'absolute',
    colorScheme: 'light',
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    color: '#111827',
    left: field.x,
    top: field.y,
    width: unit(field.width),
    height: unit(field.height),
    // Scaled from the top-left corner, which is the corner `left`/`top` already pinned.
    transform: iosZoomGuard > 1 ? `scale(${1 / iosZoomGuard})` : undefined,
    transformOrigin: '0 0',
    // Above the transparent paragraph overlay: a form's own field is the more specific thing to
    // reach for, and on a dense form its label's paragraph box often covers it.
    zIndex: 400,
  };

  const sharedProps = {
    'data-testid': 'pdf-form-field',
    'data-field-name': field.fieldName,
    'aria-label': field.label,
    disabled: field.readOnly,
    onPointerDown: (event: React.PointerEvent) => {
      event.stopPropagation();
      onActivate();
    },
    onClick: (event: React.MouseEvent) => event.stopPropagation(),
  };

  if (field.kind === 'checkbox') {
    return (
      <div
        style={baseStyle}
        className="absolute flex items-center justify-center rounded border border-paper-500 shadow-sm"
        onPointerDown={(event) => {
          event.stopPropagation();
          onActivate();
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <input
          {...sharedProps}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
          style={{ ...hit.style, width: unit(16), height: unit(16) }}
          className={`accent-blue-600 ${hit.className}`}
        />
      </div>
    );
  }

  if (field.kind === 'radio') {
    return (
      <label
        style={baseStyle}
        className="absolute flex items-center justify-center rounded border border-paper-500 shadow-sm"
        onPointerDown={(event) => {
          event.stopPropagation();
          onActivate();
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <input
          {...sharedProps}
          type="radio"
          name={field.fieldName}
          checked={typeof value === 'string' && value === field.radioValue}
          onChange={() => onChange(field.radioValue || '')}
          style={{ ...hit.style, width: unit(16), height: unit(16) }}
          className={`accent-blue-600 ${hit.className}`}
        />
      </label>
    );
  }

  if (field.kind === 'select' || field.kind === 'multiselect') {
    const currentValue = Array.isArray(value)
      ? value
      : typeof value === 'string' && value
        ? [value]
        : [];

    return (
      <select
        {...sharedProps}
        multiple={field.kind === 'multiselect'}
        value={field.kind === 'multiselect' ? currentValue : currentValue[0] || ''}
        onChange={(event) => {
          if (field.kind === 'multiselect') {
            const selectedValues = Array.from<HTMLOptionElement>(event.currentTarget.selectedOptions).map((option) => option.value);
            onChange(selectedValues);
            return;
          }

          onChange(event.currentTarget.value);
        }}
        style={{
          ...baseStyle,
          ...hit.style,
          fontSize,
          padding: `${unit(2)}px ${unit(6)}px`,
        }}
        className={`absolute rounded border border-paper-500 shadow-sm outline-none focus:border-[var(--accent-rest)] focus:ring-2 focus:ring-[var(--focus-ring)] ${hit.className}`}
      >
        {field.kind === 'select' && <option value="">{t("edit-pdf.select.1339bd")}</option>}
        {field.options?.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  if (field.kind === 'textarea') {
    return (
      <textarea
        {...sharedProps}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.currentTarget.value)}
        style={{
          ...baseStyle,
          ...hit.style,
          fontSize,
          padding: `${unit(4)}px ${unit(6)}px`,
          resize: 'none',
        }}
        className={`absolute rounded border border-paper-500 shadow-sm outline-none focus:border-[var(--accent-rest)] focus:ring-2 focus:ring-[var(--focus-ring)] ${hit.className}`}
      />
    );
  }

  return (
    <input
      {...sharedProps}
      type="text"
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => onChange(event.currentTarget.value)}
      style={{
        ...baseStyle,
        ...hit.style,
        fontSize,
        padding: `${unit(2)}px ${unit(6)}px`,
      }}
      className={`absolute rounded border border-paper-500 shadow-sm outline-none focus:border-[var(--accent-rest)] focus:ring-2 focus:ring-[var(--focus-ring)] ${hit.className}`}
    />
  );
};

// Re-implementing simplified ResizableElement
const ResizableElement: React.FC<any> = ({ element, isSelected, onSelect, onUpdate, onDelete, onBeginChange, containerRef, displayScale, pageSize, pageUserUnit }) => {
  useI18n();
  const [editMode, setEditMode] = useState<'drag' | 'resize' | null>(null);
  const origin = useRef({ pointerId: -1, clientX: 0, clientY: 0, x: 0, y: 0, width: 0.2, height: 0.1 });
  const gestureChanged = useRef(false);
  const inlineTextEditorRef = useRef<HTMLTextAreaElement>(null);
  const inlineTextChanged = useRef(false);
  const wasSelected = useRef(false);
  /** Set while a finger is down on the box: a press may become a drag, which must not open the keyboard. */
  const pressing = useRef(false);
  const tapEdits = useRef(true);
  const width = element.width || (element.type === 'text' ? 0.24 : 0.22);
  const height = element.height || (element.type === 'text' ? 0.07 : 0.14);
  const cssFontFamily = editorCssFontFamily(element.fontFamily);
  const textLayout = useMemo(() => {
    if (element.type !== 'text') return null;
    try { return layoutTextBox(element, width * pageSize.width, height * pageSize.height); }
    catch { return null; } // Unsupported text remains editable; Save reports the corrective action.
  }, [element.content, element.type, element.fontFamily, element.fontSize, element.fontWeight, element.fontStyle, width, height, pageSize.width, pageSize.height]);
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

  useEffect(() => {
    if (element.type !== 'text') return;
    // A box that was just added, or chosen from the keyboard, is ready to type over. One chosen by
    // a finger waits for the finger to lift: a drag only moves it, and a tap edits it.
    if (isSelected && !wasSelected.current && !pressing.current) {
      const inlineTextEditor = inlineTextEditorRef.current;
      if (inlineTextEditor) {
        inlineTextEditor.focus({ preventScroll: true });
        inlineTextEditor.setSelectionRange(0, inlineTextEditor.value.length);
      }
    }
    if (!isSelected) inlineTextChanged.current = false;
    wasSelected.current = isSelected;
  }, [element.type, isSelected]);

  const handleStart = (event: React.PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    pressing.current = true;
    // The move handle only moves the box; a tap on it must not open the keyboard.
    tapEdits.current = !(event.target as Element).closest('[data-move-handle]');
    onSelect();
    gestureChanged.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: element.x, y: element.y, width, height };
    setEditMode('drag');
  };

  const handleResizeStart = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    pressing.current = true;
    onSelect();
    gestureChanged.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: element.x, y: element.y, width, height };
    setEditMode('resize');
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && isSelected) {
      event.preventDefault();
      onDelete(element.id);
    }
    if (isSelected && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const step = event.shiftKey ? 0.05 : 0.01;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      const nextX = clamp(element.x + dx, 0, 1 - width);
      const nextY = clamp(element.y + dy, 0, 1 - height);
      if (nextX === element.x && nextY === element.y) return;
      if (!event.repeat) onBeginChange();
      onUpdate(element.id, {
        x: nextX,
        y: nextY,
      });
      editAnnounce?.(t(MOVED_KEYS[event.key as keyof typeof MOVED_KEYS]));
    }
  };

  const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 0.05 : 0.01;
    const nextWidth = event.key === 'ArrowLeft'
      ? width - step
      : event.key === 'ArrowRight'
        ? width + step
        : width;
    const nextHeight = event.key === 'ArrowUp'
      ? height - step
      : event.key === 'ArrowDown'
        ? height + step
        : height;
    let clampedWidth = clamp(nextWidth, 0.04, 1 - element.x);
    let clampedHeight = clamp(nextHeight, 0.025, 1 - element.y);
    if (element.type === 'image') {
      // One arrow changes one side; the other follows it.
      const scale = clamp(clampedWidth !== width ? clampedWidth / width : clampedHeight / height,
        Math.max(0.04 / width, 0.025 / height), Math.min((1 - element.x) / width, (1 - element.y) / height));
      clampedWidth = width * scale;
      clampedHeight = height * scale;
    }
    if (clampedWidth === width && clampedHeight === height) return;
    if (!event.repeat) onBeginChange();
    onUpdate(element.id, {
      width: clampedWidth,
      height: clampedHeight,
    });
  };

  useEffect(() => {
    // The edit follows the finger that started it. A second finger is a pinch: the box goes back to
    // where it started and the edit ends (s4-03).
    const handleMove = (e: PointerEvent) => {
      if (!editMode || !containerRef.current || e.pointerId !== origin.current.pointerId) return;
      const cRect = containerRef.current.getBoundingClientRect();
      const dx = (e.clientX - origin.current.clientX) / cRect.width;
      const dy = (e.clientY - origin.current.clientY) / cRect.height;
      if (editMode === 'drag') {
        const nextX = clamp(origin.current.x + dx, 0, 1 - width);
        const nextY = clamp(origin.current.y + dy, 0, 1 - height);
        if (nextX === element.x && nextY === element.y) return;
        if (!gestureChanged.current) {
          onBeginChange();
          gestureChanged.current = true;
        }
        onUpdate(element.id, {
          x: nextX,
          y: nextY,
        });
      } else {
        const start = origin.current;
        // A picture keeps its shape: the box was sized to it, and a stretched box only letterboxes it.
        const scale = element.type === 'image' ? clamp(
          Math.max((start.width + dx) / start.width, (start.height + dy) / start.height),
          Math.max(0.04 / start.width, 0.025 / start.height),
          Math.min((1 - start.x) / start.width, (1 - start.y) / start.height),
        ) : 0;
        const nextWidth = scale ? start.width * scale : clamp(start.width + dx, 0.04, 1 - start.x);
        const nextHeight = scale ? start.height * scale : clamp(start.height + dy, 0.025, 1 - start.y);
        if (nextWidth === width && nextHeight === height) return;
        if (!gestureChanged.current) {
          onBeginChange();
          gestureChanged.current = true;
        }
        onUpdate(element.id, {
          width: nextWidth,
          height: nextHeight,
        });
      }
    };

    const handleSecondFinger = (e: PointerEvent) => {
      if (e.pointerId === origin.current.pointerId) return;
      const start = origin.current;
      if (gestureChanged.current) {
        onUpdate(element.id, editMode === 'drag' ? { x: start.x, y: start.y } : { width: start.width, height: start.height });
      }
      pressing.current = false;
      gestureChanged.current = false;
      setEditMode(null);
    };

    const handleEnd = (e: PointerEvent) => {
      if (e.pointerId !== origin.current.pointerId) return;
      const tapped = editMode === 'drag' && !gestureChanged.current && tapEdits.current;
      pressing.current = false;
      gestureChanged.current = false;
      setEditMode(null);
      // A tap on a text box edits it, with the caret at the end of what is already there.
      const inlineTextEditor = inlineTextEditorRef.current;
      if (tapped && inlineTextEditor && document.activeElement !== inlineTextEditor) {
        inlineTextEditor.focus({ preventScroll: true });
        inlineTextEditor.setSelectionRange(inlineTextEditor.value.length, inlineTextEditor.value.length);
      }
    };
    if (editMode) {
       window.addEventListener('pointermove', handleMove);
       window.addEventListener('pointerup', handleEnd);
       window.addEventListener('pointercancel', handleEnd);
       window.addEventListener('pointerdown', handleSecondFinger, true);
    }
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleEnd);
      window.removeEventListener('pointercancel', handleEnd);
      window.removeEventListener('pointerdown', handleSecondFinger, true);
    };
  }, [editMode, containerRef, element.id, element.x, element.y, height, onBeginChange, onUpdate, width]);

  const shapePreview = element.type === 'rectangle' || element.type === 'ellipse'
    ? <div className="h-full w-full" style={{ border: `${element.strokeWidth || 2}px solid ${element.color || '#2563eb'}`, borderRadius: element.type === 'ellipse' ? '999px' : '4px', background: element.fillColor && element.fillColor !== 'transparent' ? `${element.fillColor}38` : 'transparent' }} />
    : element.type === 'line' || element.type === 'arrow'
      ? <svg viewBox="0 0 100 100" className="h-full w-full overflow-visible"><line x1="2" y1="2" x2="96" y2="96" stroke={element.color || '#2563eb'} strokeWidth={Math.max(1, element.strokeWidth || 2)} vectorEffect="non-scaling-stroke" />{element.type === 'arrow' && <polygon points="96,96 78,91 91,78" fill={element.color || '#2563eb'} />}</svg>
      : null;

  const selectionClass = isSelected ? 'z-[320] ring-2 ring-ink-500' : 'ring-ink-400 hover:ring-1';

  return (
    <div 
      role="group"
      tabIndex={0}
      data-testid="editor-element"
      aria-label={elementAnnouncement(element.type, isSelected, element.pageIndex + 1)}
      className={`absolute z-[300] outline-none focus-visible:ring-2 focus-visible:ring-ink-500 ${isSelected && element.type === 'text' ? 'touch-auto cursor-text' : 'touch-none cursor-move'} ${selectionClass}`}
      style={{ left: `${element.x*100}%`, top: `${element.y*100}%`, width: `${width * 100}%`, height: `${height * 100}%`, position: 'absolute', transform: element.type === 'line' || element.type === 'arrow' ? undefined : `rotate(${element.rotation || 0}deg)`, transformOrigin: 'center' }}
      onPointerDown={handleStart}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      {element.type === 'text' && isSelected ? (
        <>
         <textarea
           ref={inlineTextEditorRef}
           data-testid="inline-text-editor"
           data-element-id={element.id}
           aria-label={t("edit-pdf.edit.text.on.page.4a02ed", { v0: element.pageIndex + 1 })}
           value={element.content}
           placeholder={t("edit-pdf.text.71988c")}
           rows={1}
           aria-invalid={textLayout?.overflow || (!textLayout && !!element.content)}
           // Marked on the page as soon as the text no longer fits, not only at Save (round 5, desktop-08).
           data-overflow={textLayout?.overflow ? '' : undefined}
           spellCheck={false}
           autoCorrect="off"
           onPointerDown={(event) => event.stopPropagation()}
           onClick={(event) => event.stopPropagation()}
           onChange={(event) => {
             if (!inlineTextChanged.current) {
               onBeginChange();
               inlineTextChanged.current = true;
             }
             onUpdate(element.id, { content: event.currentTarget.value });
           }}
           onBlur={(event) => {
             inlineTextChanged.current = false;
             event.currentTarget.scrollLeft = 0;
             event.currentTarget.scrollTop = 0;
           }}
           onKeyDown={(event) => {
             event.stopPropagation();
             if (event.key === 'Escape') {
               event.preventDefault();
               event.currentTarget.blur();
             }
           }}
           className="h-full w-full touch-auto resize-none overflow-auto border-0 bg-transparent outline-none"
           style={{
             fontSize: `${(element.fontSize || 12) * pageUserUnit}px`,
             padding: `${TEXT_BOX_PADDING_Y * pageUserUnit}px ${TEXT_BOX_PADDING_X * pageUserUnit}px`,
             color: element.color,
             fontFamily: cssFontFamily,
             fontWeight: element.fontWeight,
             fontStyle: element.fontStyle,
             lineHeight: 1.2,
             whiteSpace: 'pre-wrap',
             overflowWrap: 'anywhere',
           }}
         />
        </>
      ) : element.type === 'text' ? (
         !textLayout ? <div data-testid="text-box-preview" aria-label={element.content}
           className="h-full w-full overflow-hidden"
           style={{ fontSize: `${(element.fontSize || 12) * pageUserUnit}px`,
             padding: `${TEXT_BOX_PADDING_Y * pageUserUnit}px ${TEXT_BOX_PADDING_X * pageUserUnit}px`,
             color: element.color, fontFamily: cssFontFamily, fontWeight: element.fontWeight,
             fontStyle: element.fontStyle, lineHeight: 1.2, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
           {element.content}
         </div> :
         <svg data-testid="text-box-preview" className="h-full w-full overflow-hidden"
           viewBox={`0 0 ${width * pageSize.width} ${height * pageSize.height}`}
           aria-label={element.content}>
           {textLayout.lines.map((line, index) => line.text && (
             <text key={index} x={line.x} y={line.baseline} textLength={line.width}
               lengthAdjust="spacingAndGlyphs" xmlSpace="preserve" fontSize={textLayout.fontSize}
               fontFamily={cssFontFamily} fontWeight={element.fontWeight} fontStyle={element.fontStyle}
               fill={element.color || '#000000'}>{line.text}</text>
           ))}
         </svg>
      ) : (
         element.type === 'image'
           ? <img src={element.content} alt={t("edit-pdf.added.pdf.graphic.f492bb")} className="h-full w-full object-contain pointer-events-none" />
           : shapePreview
      )}
      {isSelected && element.type === 'text' && (
        <span
          data-move-handle
          role="img"
          aria-label={t("edit-pdf.move.text.box")}
          className="absolute flex h-11 w-11 cursor-move touch-none items-center justify-center"
          // Fully outside the box's top-left corner, at the same size on screen at any zoom: the
          // first letters of the text sit right inside that corner.
          style={{ left: -44 / displayScale, top: -44 / displayScale, transform: `scale(${1 / displayScale})`, transformOrigin: 'top left' }}
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-paper-25 bg-ink-600 text-paper-25 shadow">
            <Move className="h-4 w-4" aria-hidden="true" />
          </span>
        </span>
      )}
      {isSelected && (
        <button
          type="button"
          aria-label={t("edit-pdf.resize.selected.element.with.arrow.keys.2e1370")}
          onPointerDown={handleResizeStart}
          onKeyDown={handleResizeKeyDown}
          className="absolute -bottom-[22px] -right-[22px] flex h-11 w-11 cursor-nwse-resize items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ink-500"
          style={{ transform: `scale(${1 / displayScale})` }}
        >
          <span className="h-5 w-5 rounded-full border-2 border-paper-25 bg-ink-600 shadow" />
        </button>
      )}
    </div>
  );
};

export const EditPDF: React.FC = () => {
  const { locale } = useI18n();
  const [file, setFile] = useState<PDFFile | null>(null);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [elements, setElements] = useState<EditorElement[]>([]);
  const elementsRef = useRef<EditorElement[]>([]);
  const documentGeneration = useRef(0);
  const saveInProgress = useRef(false);
  const replaceElements = useCallback((next: EditorElement[]) => {
    elementsRef.current = next;
    setElements(next);
  }, []);
  const [formFields, setFormFields] = useState<PdfFormFieldDefinition[]>([]);
  const [formValues, setFormValues] = useState<Record<string, PdfFormFieldValue>>({});
  const formValuesRef = useRef(formValues);
  formValuesRef.current = formValues;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [blockEdits, setBlockEdits] = useState<Record<string, BlockEditState>>({});
  const blockEditsRef = useRef<Record<string, BlockEditState>>({});
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const pageTextRef = useRef<Map<number, PageTextBlocks>>(new Map());
  const blockColorsRef = useRef<Record<string, BlockColors>>({});
  const blockIndexRef = useRef<Map<string, PdfTextBlock>>(new Map());
  const [blocksVersion, setBlocksVersion] = useState(0);
  const [devanagariFontsVersion, setDevanagariFontsVersion] = useState(0);
  const [embeddedFontsVersion, setEmbeddedFontsVersion] = useState(0);
  const [devanagariFontError, setDevanagariFontError] = useState(false);
  const [pagesWithoutText, setPagesWithoutText] = useState<number[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findReplacement, setFindReplacement] = useState('');
  // What Replace all just did, said inside Find, where the reader is looking while the keyboard is up.
  const [findReport, setFindReport] = useState('');
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findShowReplace, setFindShowReplace] = useState(false);
  const [findIndex, setFindIndex] = useState(0);
  const [findScanning, setFindScanning] = useState(false);
  const replaceBlockEdits = useCallback((next: Record<string, BlockEditState>) => {
    blockEditsRef.current = next;
    setBlockEdits(next);
  }, []);
  const [targetPageIndex, setTargetPageIndex] = useState(0);
  const [shapeKind, setShapeKind] = useState<EditorElement['type']>('rectangle');
  const [insertMode, setInsertMode] = useState<'text' | 'shape' | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState(() => serializeEditorState([], {}));
  const [immersiveBottomBarHeight, setImmersiveBottomBarHeight] = useState(96);
  const [immersiveHeaderHeight, setImmersiveHeaderHeight] = useState(112);
  const [, setHistoryVersion] = useState(0);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pdfZoomViewportRef = useRef<HTMLDivElement | null>(null);
  const immersiveBottomBarRef = useRef<HTMLDivElement>(null);
  const immersiveHeaderRef = useRef<HTMLElement>(null);
  const undoStack = useRef<EditorSnapshot[]>([]);
  const redoStack = useRef<EditorSnapshot[]>([]);
  const inspectorTextChanged = useRef(false);
  const replacingSourceIds = useRef(new Set<string>());
  const activeNativeFileRef = useRef<File | null>(null);
  
  // Editing needs more magnification than reading does. On a phone, body text at eleven points is
  // roughly seven CSS pixels once the page is fitted to the screen, and no caret is usable there.
  const { zoom, zoomIn, zoomOut, resetZoom, setExactZoom } = useZoom(1.0, 0.5, EDITOR_MAX_ZOOM);

  useEffect(() => {
    activeNativeFileRef.current = file?.file ?? null;
  }, [file]);

  useEffect(() => () => {
    documentGeneration.current += 1;
    const activeFile = activeNativeFileRef.current;
    if (activeFile) {
      void releaseNativePdfTextDocument(activeFile);
      releaseDocumentEmbeddedFonts(activeFile);
    }
  }, []);
  const setPdfZoomViewport = usePdfPinchZoom({ zoom, setZoom: setExactZoom, max: EDITOR_MAX_ZOOM });
  const bindPdfZoomViewport = useCallback((viewport: HTMLDivElement | null) => {
    pdfZoomViewportRef.current = viewport;
    setPdfZoomViewport(viewport);
  }, [setPdfZoomViewport]);
  const selectedElement = elements.find((element) => element.id === selectedId) ?? null;
  // A paragraph's formatting row sits in the page panel's top band, beside the zoom, so choosing
  // one moves nothing on a wide screen (path to 9, part 2). A wrapped row, its status line, or an
  // added element's panel above the page can still push the page down (and change height while
  // open): the page area scrolls by the same distance each time, so the text that was clicked
  // stays under the pointer; Done undoes it (r4 desktop-08). Measured from the document top, so a
  // scrolled window is not mistaken for a move.
  const formattingOpen = Boolean(activeBlockId) || Boolean(selectedElement);
  const deskControlsRef = useRef<HTMLDivElement | null>(null);
  // The page panel's top band: the zoom, and the paragraph's formatting row while one is chosen.
  const deskBandRef = useRef<HTMLDivElement | null>(null);
  const viewportTop = useRef<number | null>(null);
  const holdPageInPlace = useCallback(() => {
    const viewport = pdfZoomViewportRef.current;
    if (!viewport) return;
    const top = viewport.getBoundingClientRect().top + window.scrollY;
    const moved = viewportTop.current === null ? 0 : Math.round(top - viewportTop.current);
    if (moved !== 0) viewport.scrollTop += moved;
    viewportTop.current = top;
  }, []);
  const wasFormattingOpen = useRef(false);
  // Every render: while the row is open (and as it closes) any move is taken back; otherwise
  // the page's place is only noted, so opening a file or the find bar moves the page as before.
  useLayoutEffect(() => {
    // Desktop only: the phone editor docks its row at the bottom, and its page box follows the
    // keyboard and the visual viewport, which this must not fight.
    if (deskControlsRef.current && (formattingOpen || wasFormattingOpen.current)) holdPageInPlace();
    else {
      const viewport = pdfZoomViewportRef.current;
      viewportTop.current = viewport ? viewport.getBoundingClientRect().top + window.scrollY : null;
    }
    wasFormattingOpen.current = formattingOpen;
  });
  // A change that is not a render (a font or image arriving) is caught by its size.
  useLayoutEffect(() => {
    const controls = deskControlsRef.current;
    if (!formattingOpen || !controls || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(holdPageInPlace);
    observer.observe(controls);
    if (deskBandRef.current) observer.observe(deskBandRef.current);
    return () => observer.disconnect();
  }, [formattingOpen, holdPageInPlace]);
  const pageCount = pdfDoc?.numPages || 0;
  // Add, move, Undo, Redo, Delete and a page change are said to a screen reader (research r4,
  // desktop-04; path to 9, part 2).
  const [announcer, announce] = useAnnouncer();
  useLayoutEffect(() => {
    editAnnounce = announce;
    return () => { if (editAnnounce === announce) editAnnounce = null; };
  }, [announce]);
  const announcedPage = useRef<number | null>(null);
  useEffect(() => {
    if (pageCount < 2) return;
    // The first page of a newly opened file is not news.
    if (announcedPage.current !== null && announcedPage.current !== targetPageIndex) {
      announce(t("edit-pdf.page.of.477c22", { v0: targetPageIndex + 1, v1: pageCount }));
    }
    announcedPage.current = targetPageIndex;
  }, [announce, pageCount, targetPageIndex]);
  const compactViewport = useCompactEditorViewport();
  const coarsePointer = useCoarsePointer();

  const isNativeAndroidEditor = Boolean(file) && Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  const isCompactViewportEditor = Boolean(file) && compactViewport;
  const isImmersiveEditor = isNativeAndroidEditor || isCompactViewportEditor;
  // On a phone a paragraph is typed into a wrapped field above the keyboard. No zoom shows both
  // whole lines and readable text there: 11 pt body text on A4 needs 165% to reach 10 px.
  // Not yet on iPhone and iPad: the caret moves to the field a frame after the tap, and iOS may not
  // raise the keyboard for focus given outside the tap itself. Untested there, so it waits.
  const dockEditing = isImmersiveEditor && coarsePointer && !APPLE_TOUCH;
  const selectedTextId = selectedElement?.type === 'text' ? selectedElement.id : null;
  const captureFocusAnchor = useKeyboardSafeFocus(
    pdfZoomViewportRef.current,
    activeBlockId,
    zoom,
    immersiveBottomBarRef.current,
    immersiveHeaderRef.current,
    selectedTextId,
    dockEditing,
  );
  // A redrawn paragraph wraps differently from the page paragraph under it, so a tap on it is read
  // off the drawing: how many letters come before the tap, and whether it landed just after one.
  const previewTapRef = useRef<{ blockId: string; letters: number; afterLetter: boolean } | null>(null);
  const readPreviewTap = useCallback((event: React.PointerEvent<HTMLElement>, blockId: string) => {
    previewTapRef.current = null;
    const drawing = event.currentTarget.querySelector<SVGSVGElement>(`svg[data-preview-block-id="${CSS.escape(blockId)}"]`);
    const rows = drawing ? [...drawing.querySelectorAll<SVGTextElement>('text')] : [];
    const matrix = drawing?.getScreenCTM();
    if (!drawing || !matrix || rows.length === 0 || getComputedStyle(drawing).direction === 'rtl') return;
    const near = (row: SVGTextElement) => {
      const box = row.getBoundingClientRect();
      const dy = Math.max(box.top - event.clientY, event.clientY - box.bottom, 0);
      const dx = Math.max(box.left - event.clientX, event.clientX - box.right, 0);
      return dy * 1000 + dx;
    };
    const row = rows.reduce((best, candidate) => (near(candidate) < near(best) ? candidate : best));
    const x = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()).x;
    const content = row.textContent ?? '';
    let index = 0;
    while (index < row.getNumberOfChars()) {
      if (x < (row.getStartPositionOfChar(index).x + row.getEndPositionOfChar(index).x) / 2) break;
      index += 1;
    }
    const letters = (value: string) => value.replace(/\s/g, '').length;
    previewTapRef.current = {
      blockId,
      letters: rows.slice(0, rows.indexOf(row)).reduce((sum, earlier) => sum + letters(earlier.textContent ?? ''), 0)
        + letters(content.slice(0, index)),
      afterLetter: index > 0 && !/\s/.test(content[index - 1]),
    };
  }, []);
  const handlePdfPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse') return;
    const element = (event.target as HTMLElement).closest<HTMLElement>('[data-block-id]');
    if (element) captureFocusAnchor(element, { x: event.clientX, y: event.clientY });
    if (dockEditing) {
      if (element?.dataset.blockId) readPreviewTap(event, element.dataset.blockId);
      else previewTapRef.current = null;
    }
  }, [captureFocusAnchor, dockEditing, readPreviewTap]);

  /**
   * Bring a paragraph up to a size that can be edited by thumb before handing it the caret.
   *
   * Zooming 12 pt text to 16 px on a phone (250%) cut every line in half, so the reader lost the
   * start and end of each sentence. The zoom now fits the paragraph's width, but never leaves its
   * text below 10 px and never goes past the 16 px zoom; on a Letter page that is about 156%. It
   * never zooms out, and Done or Back puts back the zoom the reader had, unless they changed it.
   */
  const autoZoomRef = useRef<{ from: number; to: number } | null>(null);
  /** Zoom a paragraph to the rule above. Returns whether the zoom changes. */
  const autoZoomTo = useCallback((element: HTMLElement, fitOnly = dockEditing) => {
    const viewport = pdfZoomViewportRef.current;
    if (!viewport) return false;
    // The page is drawn inside a CSS transform, so the computed font size is the unscaled one.
    // What the browser and the reader actually see is that size times the transform's scale.
    const rect = element.getBoundingClientRect();
    const layoutHeight = element.offsetHeight;
    const scale = layoutHeight > 0 ? rect.height / layoutHeight : 1;
    const renderedFontSize = Number.parseFloat(window.getComputedStyle(element).fontSize) * scale;
    if (!Number.isFinite(renderedFontSize) || renderedFontSize <= 0 || rect.width <= 0) return false;
    const fitsWidth = zoom * (viewport.clientWidth - 2 * 12) / rect.width;
    const legible = zoom * LEGIBLE_EDITING_FONT_PX / renderedFontSize;
    const ceiling = zoom * MINIMUM_EDITING_FONT_PX / renderedFontSize;
    // With the dock field the page only has to show the whole paragraph: the field is where it is read.
    const target = Math.min(EDITOR_MAX_ZOOM, ceiling, fitOnly ? fitsWidth : Math.max(fitsWidth, legible));
    // A zoom this editor chose may come down again for a wider paragraph, never below the reader's own.
    const from = autoZoomRef.current?.from ?? zoom;
    const next = Math.max(dockEditing && autoZoomRef.current ? from : zoom, target);
    if (Math.abs(next - zoom) <= 0.01) return false;
    autoZoomRef.current = { from, to: next };
    setExactZoom(next);
    return true;
  }, [dockEditing, setExactZoom, zoom]);
  // A phone (dock editing) keeps the reader's zoom when editing starts (mobile RS-MOBILE-04, final
  // fix item 12): a paragraph tap went 358 → 397 px and a new text box 358 → 596 px. The dock field
  // shows the paragraph being typed; pinch and the zoom buttons change the zoom. Find still brings
  // a match up, since nothing else shows it.
  const handleActivateBlock = useCallback((blockId: string | null) => {
    setActiveBlockId(blockId);
    if (blockId) setSelectedId(null);
    if (!blockId || !coarsePointer) return;
    const element = document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`);
    if (!element || !pdfZoomViewportRef.current) return;
    captureFocusAnchor(element);
    if (!dockEditing) autoZoomTo(element);
  }, [autoZoomTo, captureFocusAnchor, coarsePointer, dockEditing]);

  /**
   * A tap on a paragraph on the page hands the caret to the dock field, at the letter tapped. The
   * browser places the caret in the page paragraph first; it is read on the next frame.
   */
  const [fieldFocus, setFieldFocus] = useState<{ blockId: string; offset: number; nonce: number } | null>(null);
  const handlePageActivate = useCallback((blockId: string | null) => {
    // The last tap's request would otherwise focus the field again before this tap is read.
    setFieldFocus(null);
    handleActivateBlock(blockId);
    if (!blockId || !dockEditing) return;
    window.requestAnimationFrame(() => {
      const element = document.activeElement as HTMLElement | null;
      const tap = previewTapRef.current;
      previewTapRef.current = null;
      if (element?.dataset.blockId !== blockId) return;
      const selection = window.getSelection();
      let offset = Number.MAX_SAFE_INTEGER;
      if (tap?.blockId === blockId) {
        // Only spaces and line ends differ between the drawing and the text, so count letters.
        const text = blockEditsRef.current[blockId]?.text ?? element.textContent ?? '';
        let seen = 0;
        offset = text.length;
        for (let index = 0; index < text.length; index += 1) {
          if (/\s/.test(text[index])) continue;
          if (seen === tap.letters && !tap.afterLetter) { offset = index; break; }
          seen += 1;
          if (seen === tap.letters && tap.afterLetter) { offset = index + 1; break; }
        }
      } else if (selection?.focusNode && element.contains(selection.focusNode)) {
        const range = document.createRange();
        range.selectNodeContents(element);
        range.setEnd(selection.focusNode, selection.focusOffset);
        offset = range.toString().length;
      }
      setFieldFocus({ blockId, offset, nonce: Date.now() });
    });
  }, [dockEditing, handleActivateBlock]);
  // A pinch or a zoom button makes the zoom the reader's own, so it is no longer put back.
  useEffect(() => {
    if (autoZoomRef.current && Math.abs(autoZoomRef.current.to - zoom) > 0.01) autoZoomRef.current = null;
  }, [zoom]);
  useEffect(() => {
    if (activeBlockId || !autoZoomRef.current) return;
    const { from } = autoZoomRef.current;
    autoZoomRef.current = null;
    setExactZoom(from);
  }, [activeBlockId, setExactZoom]);
  const currentSnapshot = useMemo(
    () => serializeEditorState(elements, formValues, blockEdits),
    [blockEdits, elements, formValues],
  );
  const hasUnsavedEdits = Boolean(file) && currentSnapshot !== savedSnapshot;
  // The edits are the input of the result strip's file: a later edit makes it an earlier result.
  useWorkInput(currentSnapshot);
  // A finished save's message describes that file. The next change makes it out of date.
  const savedMessageAt = useRef<string | null>(null);
  useEffect(() => {
    const finished = !status.isProcessing && status.progress === 100 && !status.error && Boolean(status.message);
    if (!finished) {
      savedMessageAt.current = null;
    } else if (savedMessageAt.current === null) {
      savedMessageAt.current = currentSnapshot;
    } else if (savedMessageAt.current !== currentSnapshot) {
      savedMessageAt.current = null;
      setStatus({ isProcessing: false, progress: 0, message: '' });
      // The exported file's strip goes with it: it sits over the editing controls.
      dismissOutputBanner();
    }
  }, [currentSnapshot, status]);
  // Found on a phone: after a save, opening Find left the strip over Find's own row. Going back to
  // work on the page, before any change, is reason enough for it to go.
  useEffect(() => {
    if (findOpen || activeBlockId || selectedId) dismissOutputBanner();
  }, [activeBlockId, findOpen, selectedId]);

  useShellOwnChrome(isImmersiveEditor);
  const routeTool = useRouteTool();
  const narrowHeader = useMediaQuery('(max-width: 439.98px)');

  useEffect(() => {
    if (!isImmersiveEditor || !immersiveBottomBarRef.current) return undefined;
    const bottomBar = immersiveBottomBarRef.current;
    const updateHeight = () => {
      const nextHeight = Math.ceil(bottomBar.getBoundingClientRect().height);
      if (nextHeight > 0) setImmersiveBottomBarHeight(nextHeight);
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(bottomBar);
    return () => observer.disconnect();
  }, [isImmersiveEditor]);

  useEffect(() => {
    if (!isImmersiveEditor || !immersiveHeaderRef.current) return undefined;
    const header = immersiveHeaderRef.current;
    const updateHeight = () => {
      const nextHeight = Math.ceil(header.getBoundingClientRect().height);
      if (nextHeight > 0) setImmersiveHeaderHeight(nextHeight);
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(header);
    return () => observer.disconnect();
  }, [isImmersiveEditor]);

  const goToPage = useCallback((nextPageIndex: number) => {
    if (pageCount <= 0) return;
    setTargetPageIndex(Math.max(0, Math.min(pageCount - 1, nextPageIndex)));
    setSelectedId(null);
    setActiveBlockId(null);
    setInsertMode(null);
  }, [pageCount]);

  useEffect(() => {
    const viewport = pdfZoomViewportRef.current;
    if (!viewport || pageCount < 2) return undefined;
    let changingPage = false;
    let releaseTimer: number | undefined;

    const atStart = () => viewport.scrollTop <= 2;
    const atEnd = () => viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2;
    const turnTo = (nextPage: number) => {
      changingPage = true;
      const movingForward = nextPage > targetPageIndex;
      goToPage(nextPage);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const nextViewport = pdfZoomViewportRef.current;
          if (!nextViewport) return;
          nextViewport.scrollTop = movingForward
            ? 0
            : Math.max(0, nextViewport.scrollHeight - nextViewport.clientHeight);
          releaseTimer = window.setTimeout(() => { changingPage = false; }, 250);
        });
      });
    };

    const handlePageBoundaryWheel = (event: WheelEvent) => {
      if (event.ctrlKey || changingPage) return;
      const nextPage = pdfPageFromScrollBoundary({
        currentPage: targetPageIndex,
        pageCount,
        zoom,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        atStart: atStart(),
        atEnd: atEnd(),
      });
      if (nextPage === targetPageIndex) return;
      event.preventDefault();
      turnTo(nextPage);
    };

    // One finger only, and not while something on the page is being edited or moved.
    let swipe: { x: number; y: number; atStart: boolean; atEnd: boolean } | null = null;
    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      const target = event.target as HTMLElement;
      swipe = event.touches.length === 1 && touch && !activeBlockId && !selectedId && !insertMode
        && !target.closest('input, textarea, select, [data-testid="editor-element"]')
        ? { x: touch.clientX, y: touch.clientY, atStart: atStart(), atEnd: atEnd() }
        : null;
    };
    const cancelSwipe = (event: TouchEvent) => { if (event.touches.length > 1) swipe = null; };
    const handleTouchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      const started = swipe;
      swipe = null;
      if (!started || !touch || changingPage || viewport.dataset.pdfPinching === 'true') return;
      const nextPage = pdfPageFromSwipe({
        currentPage: targetPageIndex,
        pageCount,
        deltaX: touch.clientX - started.x,
        deltaY: touch.clientY - started.y,
        startedAtStart: started.atStart,
        startedAtEnd: started.atEnd,
      });
      if (nextPage !== targetPageIndex) turnTo(nextPage);
    };

    viewport.addEventListener('wheel', handlePageBoundaryWheel, { passive: false });
    viewport.addEventListener('touchstart', handleTouchStart, { passive: true });
    viewport.addEventListener('touchmove', cancelSwipe, { passive: true });
    viewport.addEventListener('touchend', handleTouchEnd, { passive: true });
    viewport.addEventListener('touchcancel', cancelSwipe, { passive: true });
    return () => {
      viewport.removeEventListener('wheel', handlePageBoundaryWheel);
      viewport.removeEventListener('touchstart', handleTouchStart);
      viewport.removeEventListener('touchmove', cancelSwipe);
      viewport.removeEventListener('touchend', handleTouchEnd);
      viewport.removeEventListener('touchcancel', cancelSwipe);
      if (releaseTimer !== undefined) window.clearTimeout(releaseTimer);
    };
  }, [activeBlockId, goToPage, insertMode, isImmersiveEditor, pageCount, selectedId, targetPageIndex, zoom]);

  const handleFilesSelected = async (files: File[]) => {
    if (files.length === 0) return;
    const nextFile = files[0];
    dismissOutputBanner();
    const generation = ++documentGeneration.current;
    replacingSourceIds.current.clear();
    if (file?.file) {
      void releaseNativePdfTextDocument(file.file);
      releaseDocumentEmbeddedFonts(file.file);
    }
    setPdfDoc(null);
    replaceElements([]);
    replaceBlockEdits({});
    setActiveBlockId(null);
    pageTextRef.current = new Map();
    blockIndexRef.current = new Map();
    blockColorsRef.current = {};
    setPagesWithoutText([]);
    setFindOpen(false);
    setFindQuery('');
    // Font keys are only unique inside one document, so the resolved-font caches go with it.
    resetFontResolutionCaches();
    setSelectedId(null);
    setFormFields([]);
    setFormValues({});
    setTargetPageIndex(0);
    // Each document opens fitted to the screen, not at the zoom the last one was left at.
    resetZoom();
    pdfZoomViewportRef.current?.scrollTo({ top: 0, left: 0 });
    setInsertMode(null);
    undoStack.current = [];
    redoStack.current = [];
    setHistoryVersion((value) => value + 1);
    setFile(null);
    setStatus({ isProcessing: true, progress: 10, message: t("edit-pdf.opening.this.pdf.locally.dec628") });
    let doc: any = null;
    try {
      doc = await loadEditablePDFDocument(nextFile);
      if (generation !== documentGeneration.current) {
        void doc.destroy();
        return;
      }
      setPdfDoc(doc);
      setSavedSnapshot(serializeEditorState([], {}));
      setFile({ id: uuidv4(), file: nextFile, name: nextFile.name, size: nextFile.size });
      setStatus({
        isProcessing: false,
        progress: 100,
        message: '',
      });

      // A document can permit reading and forbid changes. It opens and edits perfectly well on
      // screen, so without this the reader finds out only when they press Save, after the work.
      void doc.getPermissions?.().then((permissions: Iterable<number> | null) => {
        if (generation !== documentGeneration.current || !permissions) return;
        // PDF.js has returned this as an array and as a set across versions; either is iterable.
        const granted = new Set<number>(permissions);
        if (granted.has(PDF_PERMISSION_MODIFY_CONTENTS)) return;
        setStatus((current) => (current.error || current.isProcessing ? current : {
          isProcessing: false,
          progress: 0,
          message: t("edit-pdf.this.pdf.allows.reading.but.not.changes.e84779"),
        }));
      }).catch(() => {
        // A document that will not report its permissions is treated as an ordinary one; the save
        // path names the problem if there turns out to be one.
      });

      // Finding a document's form fields means asking every page for its annotations, which on a
      // long report is seconds of nothing on screen — for a document that usually has none. The
      // page is shown as soon as it can be, and the fields arrive when they arrive.
      void getPdfFormFields(doc).then((nextFields) => {
        if (generation !== documentGeneration.current || nextFields.length === 0) return;
        const nextFormValues = buildInitialFormValues(nextFields);
        setFormFields(nextFields);
        setFormValues(nextFormValues);
        setSavedSnapshot((current) => (current === serializeEditorState([], {})
          ? serializeEditorState([], nextFormValues)
          : current));
      }).catch(() => {
        // A document whose annotations cannot be read is still perfectly editable as text.
      });
    } catch (error) {
      if (doc?.destroy) void doc.destroy();
      if (generation !== documentGeneration.current) return;
      setPdfDoc(null);
      const reason = error instanceof Error ? error.message : '';
      const name = (error as { name?: string })?.name ?? '';
      const encrypted = name === 'PasswordException' || /password|encrypt/i.test(reason);
      const damaged = name === 'InvalidPDFException' || /invalid pdf|structure|corrupt/i.test(reason);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        // The library's own wording is a diagnostic, not an instruction. Say what the reader can
        // do about it, and name the tool that does it.
        error: encrypted
          ? t("edit-pdf.this.pdf.is.password.protected.so.its.61949e")
          : damaged
            ? t("edit-pdf.this.file.could.not.be.read.as.bba069")
            : reason || t("edit-pdf.unable.to.open.this.pdf.9c2826"),
      });
    }
  };

  useEffect(() => {
    return () => {
      if (pdfDoc?.destroy) {
        void pdfDoc.destroy();
      }
    };
  }, [pdfDoc]);

  const captureSnapshot = (): EditorSnapshot => ({
    elements: elementsRef.current.map((element) => ({ ...element })),
    blockEdits: { ...blockEditsRef.current },
    formValues: formValuesRef.current,
  });

  const restoreSnapshot = (snapshot: EditorSnapshot) => {
    replaceElements(snapshot.elements);
    replaceBlockEdits(snapshot.blockEdits);
    formValuesRef.current = snapshot.formValues;
    setFormValues(snapshot.formValues);
  };

  const rememberSnapshot = () => {
    typingBlockRef.current = null;
    undoStack.current = [...undoStack.current.slice(-79), captureSnapshot()];
    redoStack.current = [];
    setHistoryVersion((value) => value + 1);
  };

  const commitElements = (updater: (current: EditorElement[]) => EditorElement[]) => {
    const next = updater(elementsRef.current);
    if (next === elementsRef.current) return;
    typingBlockRef.current = null;
    undoStack.current = [...undoStack.current.slice(-79), captureSnapshot()];
    redoStack.current = [];
    replaceElements(next);
    setHistoryVersion((value) => value + 1);
  };

  const undo = () => {
    const previous = undoStack.current[undoStack.current.length - 1];
    if (!previous) return;
    redoStack.current = [...redoStack.current, captureSnapshot()];
    undoStack.current = undoStack.current.slice(0, -1);
    typingBlockRef.current = null;
    restoreSnapshot(previous);
    setSelectedId(null);
    setHistoryVersion((value) => value + 1);
    announce(t('edit.undone'));
  };

  /** Undo and Redo leave the caret and the keyboard where they are, like the zoom buttons. */
  const holdEditingFocus = (event: React.PointerEvent) => {
    // With the keyboard closed the button may take focus: keeping it in the text would reopen the keyboard.
    if (event.pointerType === 'mouse' || document.documentElement.hasAttribute('data-chef-keyboard')) event.preventDefault();
  };

  const redo = () => {
    const next = redoStack.current[redoStack.current.length - 1];
    if (!next) return;
    undoStack.current = [...undoStack.current, captureSnapshot()];
    redoStack.current = redoStack.current.slice(0, -1);
    typingBlockRef.current = null;
    restoreSnapshot(next);
    setSelectedId(null);
    setHistoryVersion((value) => value + 1);
    announce(t('edit.redone'));
  };

  /** The middle of the part of the page on screen, so something added appears where the reader is looking. */
  const visiblePageCentre = () => {
    const viewport = pdfZoomViewportRef.current;
    const page = viewport?.querySelector<HTMLElement>(`[data-pdf-page="${targetPageIndex}"]`);
    if (!viewport || !page) return null;
    const view = viewport.getBoundingClientRect();
    const bounds = page.getBoundingClientRect();
    const left = Math.max(view.left, bounds.left);
    const right = Math.min(view.right, bounds.right);
    const top = Math.max(view.top, bounds.top);
    const bottom = Math.min(view.bottom, bounds.bottom);
    if (right <= left || bottom <= top || bounds.width <= 0 || bounds.height <= 0) return null;
    return { x: ((left + right) / 2 - bounds.left) / bounds.width, y: ((top + bottom) / 2 - bounds.top) / bounds.height };
  };

  // A new text box starts empty, so nothing is saved that the reader did not type. An empty one
  // that is not selected is taken away, whether it was let go empty or Undo emptied it.
  useEffect(() => {
    const empty = elements.filter((element) => element.type === 'text' && element.id !== selectedId && !element.content.trim());
    if (empty.length > 0) replaceElements(elements.filter((element) => !empty.includes(element)));
  }, [elements, replaceElements, selectedId]);

  // Found on a phone: a new shape could land under its own panel, which opens with it. Once the
  // panel is up, the new item is scrolled clear of it.
  const revealElementRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || selectedId !== revealElementRef.current) return undefined;
    revealElementRef.current = null;
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        const viewport = pdfZoomViewportRef.current;
        const node = viewport?.querySelector(`[data-element-id="${CSS.escape(selectedId)}"]`);
        if (viewport && node) scrollBlockIntoViewport(viewport, node, immersiveBottomBarRef.current?.getBoundingClientRect().top);
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedId]);

  const addText = (x?: number, y?: number) => {
    const centre = x === undefined || y === undefined ? visiblePageCentre() : null;
    x ??= centre ? centre.x - 0.14 : 0.1;
    y ??= centre ? centre.y - 0.035 : 0.1;
    const newEl: EditorElement = {
      id: uuidv4(), type: 'text', pageIndex: targetPageIndex,
      x: Math.min(0.72, Math.max(0, x)),
      y: Math.min(0.93, Math.max(0, y)),
      width: 0.28, height: 0.07, content: '', fontSize: 16, color: '#000000', fontFamily: 'Helvetica'
    };
    commitElements((current) => [...current, newEl]);
    setSelectedId(newEl.id);
    revealElementRef.current = newEl.id;
    setInsertMode(null);
    announce(elementAdded(newEl.type, newEl.pageIndex + 1));
  };

  const addShape = (x?: number, y?: number) => {
    const centre = x === undefined || y === undefined ? visiblePageCentre() : null;
    x ??= centre ? centre.x - 0.12 : 0.12;
    y ??= centre ? centre.y - 0.08 : 0.14;
    const newEl: EditorElement = {
      id: uuidv4(),
      type: shapeKind,
      pageIndex: targetPageIndex,
      x: Math.min(0.76, Math.max(0, x)),
      y: Math.min(0.84, Math.max(0, y)),
      width: 0.24,
      height: shapeKind === 'line' || shapeKind === 'arrow' ? 0.12 : 0.16,
      content: '',
      // The dock's blue swatch, so a new shape shows which colour it has.
      color: '#1565c0',
      fillColor: 'transparent',
      strokeWidth: 2,
    };
    commitElements((current) => [...current, newEl]);
    setSelectedId(newEl.id);
    revealElementRef.current = newEl.id;
    setInsertMode(null);
    announce(elementAdded(newEl.type, newEl.pageIndex + 1));
  };

  const toggleInsertMode = (mode: 'text' | 'shape') => {
    setActiveBlockId(null);
    setSelectedId(null);
    setInsertMode((current) => current === mode ? null : mode);
  };

  const handlePagePress = ({ x, y }: { x: number; y: number }) => {
    if (insertMode === 'text') {
      addText(x - 0.03, y - 0.025);
      return;
    }
    if (insertMode === 'shape') {
      // Centred on the finger, so the whole shape lands where it was put rather than mostly to
      // the right of it and off a zoomed-in screen.
      addShape(x - 0.12, y - (shapeKind === 'line' || shapeKind === 'arrow' ? 0.06 : 0.08));
      return;
    }
    setSelectedId(null);
  };

  const readCachedPageText = useCallback(
    (pageIndex: number) => pageTextRef.current.get(pageIndex),
    [],
  );

  const handleBlocksReady = useCallback((
    pageIndex: number,
    pageText: PageTextBlocks,
    colors: Record<string, BlockColors>,
  ) => {
    pageTextRef.current.set(pageIndex, pageText);
    setPagesWithoutText((current) => {
      const without = pageText.hasTextLayer
        ? current.filter((page) => page !== pageIndex)
        : current.includes(pageIndex) ? current : [...current, pageIndex].sort((a, b) => a - b);
      return without.length === current.length && without.every((page, index) => page === current[index])
        ? current
        : without;
    });
    pageText.blocks.forEach((block) => blockIndexRef.current.set(block.id, block));
    blockColorsRef.current = { ...blockColorsRef.current, ...colors };
    // A replace-all can edit paragraphs on pages the reader has never opened, and those had no
    // rendered pixels to sample. Now that this page has been drawn, give those edits its real ink
    // and paper instead of the black-on-white they had to start with.
    const pending = (Object.values(blockEditsRef.current) as BlockEditState[])
      .filter((edit) => edit.pageIndex === pageIndex && edit.sampledColors !== true && colors[edit.blockId]);
    if (pending.length > 0) {
      const next = { ...blockEditsRef.current };
      pending.forEach((edit) => {
        next[edit.blockId] = {
          ...edit,
          color: edit.color ?? colors[edit.blockId].ink,
          patchColor: colors[edit.blockId].paper,
          patchFlat: colors[edit.blockId].flat,
          sampledColors: true,
        };
      });
      replaceBlockEdits(next);
    }
    setBlocksVersion((value) => value + 1);
  }, [replaceBlockEdits]);

  /**
   * Fetch a text-free render of a paragraph's area the first time it changes, so the original
   * words can be hidden without painting a white box over whatever sits behind them.
   */
  const requestBlockPatch = useCallback(async (block: PdfTextBlock) => {
    const generation = documentGeneration.current;
    const pageText = pageTextRef.current.get(block.pageIndex);
    if (!file || !pageText) return;
    // Ink-coloured rules and drawings cannot be distinguished from glyphs by a colour histogram.
    // Only a render with text omitted can safely reproduce the area behind an edited paragraph.
    try {
      // The editor's own document, not a second copy of the file: one page render at a time is
      // serialised by the queue above, and a second parse of a 200-page report is tens of
      // megabytes for nothing.
      const patchDocument = pdfDoc;
      if (!patchDocument) return;
      const patch = await getPageTextBackgroundPatch(patchDocument, block.pageIndex, {
        text: block.text,
        left: block.left,
        top: block.top,
        width: Math.max(block.width, block.measure),
        height: block.height,
      });
      if (generation !== documentGeneration.current) return;
      const existing = blockEditsRef.current[block.id];
      if (!existing) return;
      replaceBlockEdits({ ...blockEditsRef.current, [block.id]: { ...existing, patch, patchFlat: false } });
    } catch {
      // Keep the narrow run masks if the background cannot be reconstructed safely. A whole
      // paragraph fill could erase table rules or unrelated drawings between its lines.
    }
  }, [pdfDoc, replaceBlockEdits]);

  /**
   * One visit to a paragraph is one Undo step. The editable can lose track of its typing session
   * mid-word — its content is rebuilt whenever the edit changes from outside, such as when typing
   * returns it to the original — and each restart used to push another snapshot, so one Undo
   * landed on a state the reader never saw. Any other change, or leaving the paragraph, starts a
   * new step.
   */
  const typingBlockRef = useRef<string | null>(null);
  const handleBeginBlockChange = useCallback((blockId: string) => {
    if (typingBlockRef.current === blockId) return;
    rememberSnapshot();
    typingBlockRef.current = blockId;
  }, []);
  useEffect(() => { typingBlockRef.current = null; }, [activeBlockId]);

  const handleBlockChange = useCallback((
    blockId: string, text: string, segments: StyledSegment[][], softBreaks?: number[],
  ) => {
    const block = blockIndexRef.current.get(blockId);
    if (!block) return;
    const existing = blockEditsRef.current[blockId];
    const colors = blockColorsRef.current[blockId];
    // Typing a paragraph back to what the document says is no change at all, so it stops counting
    // as one: Save, Revert and the status all go back to how they were before the first keystroke.
    if (text === block.text && !hasParagraphRestyle(existing, colors?.ink)
      && styledTextEqual(segments, blockStyledSegments(block, colors?.glyphs), block.fontSize)) {
      if (existing) {
        const withoutIt = { ...blockEditsRef.current };
        delete withoutIt[blockId];
        replaceBlockEdits(withoutIt);
      }
      return;
    }
    const next: BlockEditState = {
      // Whatever was already chosen for the paragraph, such as a colour picked for all of it,
      // outlives the next keystroke.
      ...existing,
      blockId,
      pageIndex: block.pageIndex,
      text,
      segments,
      // A break typed in stays a break when the paragraph is redrawn; the PDF's own wrapping
      // may flow again.
      softBreaks: softBreaks ?? carrySoftBreaks(existing?.softBreaks, block, existing?.text ?? block.text, text),
      color: existing?.color ?? colors?.ink,
      patchColor: existing?.patchColor ?? colors?.paper ?? '#ffffff',
      patchFlat: existing?.patchFlat ?? colors?.flat ?? false,
      sampledColors: existing?.sampledColors ?? Boolean(colors),
      reflowing: existing?.reflowing ?? false,
    };
    replaceBlockEdits({ ...blockEditsRef.current, [blockId]: next });

  }, [replaceBlockEdits, requestBlockPatch]);

  /** The paragraph's text as styled segments: what it was edited to, or what the PDF drew. */
  const blockSegments = useCallback((block: PdfTextBlock, edit: BlockEditState | undefined) => (
    edit?.segments ?? blockStyledSegments(block, blockColorsRef.current[block.id]?.glyphs)
  ), []);

  /**
   * Find runs over every page, not just the one on screen, so a replace-all means what it says.
   * Pages the reader has not reached yet are extracted on demand and then cached with the rest.
   */
  const scanAllPages = useCallback(async () => {
    if (!pdfDoc) return;
    const generation = documentGeneration.current;
    const missing = Array.from({ length: pdfDoc.numPages }, (_, index) => index)
      .filter((index) => !pageTextRef.current.has(index));
    if (missing.length === 0) return;
    setFindScanning(true);
    try {
      for (const index of missing) {
        const pageText = await getPageTextBlocks(pdfDoc, index);
        if (generation !== documentGeneration.current) return;
        pageTextRef.current.set(index, pageText);
        pageText.blocks.forEach((block) => blockIndexRef.current.set(block.id, block));
      }
      setBlocksVersion((value) => value + 1);
    } finally {
      if (generation === documentGeneration.current) setFindScanning(false);
    }
  }, [pdfDoc]);

  useEffect(() => {
    if (findOpen) void scanAllPages();
  }, [findOpen, scanAllPages]);

  const findMatches = useMemo(() => {
    void blocksVersion;
    if (!findQuery) return [] as Array<{ pageIndex: number; blockId: string; match: StyledMatch; offset: number }>;
    const found: Array<{ pageIndex: number; blockId: string; match: StyledMatch; offset: number }> = [];
    [...pageTextRef.current.keys()].sort((a, b) => a - b).forEach((pageIndex) => {
      pageTextRef.current.get(pageIndex)?.blocks.forEach((block) => {
        const lines = blockSegments(block, blockEdits[block.id]);
        findInStyledLines(lines, findQuery, findCaseSensitive).forEach((match) => {
          // The overlay holds the paragraph as one string with newlines, so a match's position on
          // its line becomes an offset the caret can be placed at.
          const before = lines.slice(0, match.line).reduce((total, line) => total + styledLineText(line).length + 1, 0);
          found.push({ pageIndex, blockId: block.id, match, offset: before + match.start });
        });
      });
    });
    return found;
  }, [blockEdits, blockSegments, blocksVersion, findCaseSensitive, findQuery]);

  useEffect(() => {
    setFindIndex((current) => (findMatches.length === 0 ? 0 : Math.min(current, findMatches.length - 1)));
  }, [findMatches.length]);

  /** Choosing an added item or a form field ends the paragraph edit, so two panels never stack. */
  const selectElement = useCallback((id: string | null) => {
    setSelectedId(id);
    setActiveBlockId(null);
  }, []);

  const revealMatch = useCallback((index: number) => {
    const match = findMatches[index];
    if (!match) return;
    if (match.pageIndex !== targetPageIndex) goToPage(match.pageIndex);
    // The page may still be rendering, so try again on the next frames rather than once.
    let attempts = 0;
    let zoomed = false;
    const place = () => {
      const element = document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(match.blockId)}"]`);
      const length = match.match.end - match.match.start;
      const range = element ? blockRange(element, match.offset, match.offset + length) : null;
      // Shown, not entered: the caret and the keyboard stay in the find field, so Enter and Next
      // keep searching instead of typing into the document. Tapping the match edits it.
      if (range) {
        // On a phone a match at fit zoom is about 6 px text: its paragraph is brought up to the
        // screen's width first, as when it is edited, and put back when Find closes.
        if (!zoomed && element && dockEditing) {
          zoomed = true;
          if (autoZoomTo(element)) {
            window.requestAnimationFrame(() => window.requestAnimationFrame(place));
            return;
          }
        }
        const viewport = pdfZoomViewportRef.current;
        if (!viewport) return;
        // The whole width of the match's paragraph, when it fits, so its lines read to the end.
        if (dockEditing && element) {
          const view = viewport.getBoundingClientRect();
          const paragraph = element.getBoundingClientRect();
          if (paragraph.width <= view.width) viewport.scrollLeft += (paragraph.left + paragraph.right - view.left - view.right) / 2;
        }
        scrollBlockIntoViewport(viewport, range, immersiveBottomBarRef.current?.getBoundingClientRect().top);
        return;
      }
      if (attempts < 40) {
        attempts += 1;
        window.requestAnimationFrame(place);
      }
    };
    window.requestAnimationFrame(place);
  }, [autoZoomTo, dockEditing, findMatches, goToPage, targetPageIndex]);

  // Every match on the page the reader is looking at, painted at once. Rebuilt whenever the
  // matches, the page or the paragraphs themselves change, because the ranges point at live nodes.
  useEffect(() => {
    if (!findOpen || !findQuery) {
      clearFindHighlights();
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      const ranges = findMatches.flatMap((match) => {
        if (match.pageIndex !== targetPageIndex) return [];
        const element = document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(match.blockId)}"]`);
        if (!element) return [];
        const range = blockRange(element, match.offset, match.offset + (match.match.end - match.match.start));
        return range ? [{ range, current: match === findMatches[findIndex] }] : [];
      });
      paintFindHighlights(ranges.map((entry) => entry.range), ranges.find((entry) => entry.current)?.range);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [blockEdits, blocksVersion, findIndex, findMatches, findOpen, findQuery, targetPageIndex]);

  useEffect(() => clearFindHighlights, []);

  /** Which match was last brought into view. A new search has shown none, so Enter shows the first. */
  const shownMatchRef = useRef<number | null>(null);
  // Matches show as the query is typed, so Enter then goes on to the second.
  useEffect(() => {
    if (!findOpen || !findQuery || findMatches.length === 0 || shownMatchRef.current !== null) return;
    shownMatchRef.current = 0;
    revealMatch(0);
  }, [findMatches, findOpen, findQuery, revealMatch]);
  // Opening Replace makes the bar taller, which used to hide the match it is about to replace.
  useEffect(() => {
    if (!findShowReplace || shownMatchRef.current === null) return undefined;
    const timer = window.setTimeout(() => revealMatch(shownMatchRef.current ?? 0), 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findShowReplace]);
  const stepMatch = useCallback((delta: number) => {
    if (findMatches.length === 0) return;
    const next = shownMatchRef.current === null
      ? Math.min(findIndex, findMatches.length - 1)
      : (findIndex + delta + findMatches.length) % findMatches.length;
    shownMatchRef.current = next;
    setFindIndex(next);
    revealMatch(next);
  }, [findIndex, findMatches.length, revealMatch]);

  const commitBlockSegments = useCallback((
    updates: Array<{ block: PdfTextBlock; lines: StyledSegment[][] }>,
  ) => {
    if (updates.length === 0) return;
    rememberSnapshot();
    const next = { ...blockEditsRef.current };
    updates.forEach(({ block, lines }) => {
      const colors = blockColorsRef.current[block.id];
      const existing = next[block.id];
      next[block.id] = {
        ...(existing ?? {
          blockId: block.id,
          pageIndex: block.pageIndex,
          color: colors?.ink,
          patchColor: colors?.paper ?? '#ffffff',
          patchFlat: colors?.flat ?? false,
          sampledColors: Boolean(colors),
          reflowing: false,
        }),
        blockId: block.id,
        pageIndex: block.pageIndex,
        text: lines.map(styledLineText).join('\n'),
        segments: lines,
      };
      next[block.id].softBreaks = carrySoftBreaks(existing?.softBreaks, block,
        existing?.text ?? block.text, next[block.id].text);
    });
    replaceBlockEdits(next);
  }, [replaceBlockEdits, requestBlockPatch]);

  const replaceCurrentMatch = useCallback(() => {
    const target = findMatches[findIndex];
    const block = target && blockIndexRef.current.get(target.blockId);
    if (!target || !block) return;
    const lines = blockSegments(block, blockEditsRef.current[block.id]);
    const { lines: next, replaced } = replaceInStyledLines(
      lines, findQuery, findReplacement, findCaseSensitive, target.match,
    );
    if (replaced === 0) return;
    commitBlockSegments([{ block, lines: next }]);
  }, [blockSegments, commitBlockSegments, findCaseSensitive, findIndex, findMatches, findQuery, findReplacement]);

  const replaceAllMatches = useCallback(() => {
    const byBlock = new Map<string, PdfTextBlock>();
    findMatches.forEach((match) => {
      const block = blockIndexRef.current.get(match.blockId);
      if (block) byBlock.set(match.blockId, block);
    });
    const updates: Array<{ block: PdfTextBlock; lines: StyledSegment[][] }> = [];
    let total = 0;
    byBlock.forEach((block) => {
      const { lines, replaced } = replaceInStyledLines(
        blockSegments(block, blockEditsRef.current[block.id]),
        findQuery,
        findReplacement,
        findCaseSensitive,
      );
      if (replaced > 0) {
        updates.push({ block, lines });
        total += replaced;
      }
    });
    if (updates.length === 0) return;
    commitBlockSegments(updates);
    const report = updates.length === 1 ? t('editor.replaced.singleParagraph', { count: total }) : t('editor.replaced.multipleParagraphs', { count: total, paragraphCount: updates.length });
    setFindReport(report);
    // Find reads pages without their fonts, and a paragraph whose font has not been read passes
    // the check for characters it cannot draw. Reading them now shows a paragraph that cannot
    // change before Save rather than after it.
    const generation = documentGeneration.current;
    void (async () => {
      let upgraded = false;
      for (const pageIndex of new Set(updates.map(({ block }) => block.pageIndex))) {
        const pageText = pageTextRef.current.get(pageIndex);
        if (!pdfDoc || !pageText || ![...pageText.fonts.values()].some((font) => font.resolution === 'pending')) continue;
        if (await resolvePageFonts(pdfDoc, pageIndex, pageText.fonts)) upgraded = true;
        if (generation !== documentGeneration.current) return;
      }
      if (!upgraded) return;
      resetFontResolutionCaches();
      setBlocksVersion((value) => value + 1);
    })();
  }, [blockSegments, commitBlockSegments, findCaseSensitive, findMatches, findQuery, findReplacement, pdfDoc]);

  const revertBlock = useCallback((blockId: string) => {
    if (!blockEditsRef.current[blockId]) return;
    rememberSnapshot();
    const next = { ...blockEditsRef.current };
    delete next[blockId];
    replaceBlockEdits(next);
  }, [replaceBlockEdits]);

  const updateBlockEdit = useCallback((blockId: string, updates: Partial<BlockEditState>) => {
    const block = blockIndexRef.current.get(blockId);
    const existing = blockEditsRef.current[blockId];
    if (!block) return;
    // A colour picker reports every step of a drag. One pass through it is one Undo step.
    const colourOnly = Object.keys(updates).length === 1 && updates.color !== undefined;
    if (!colourOnly || typingBlockRef.current !== `colour:${blockId}`) rememberSnapshot();
    if (colourOnly) typingBlockRef.current = `colour:${blockId}`;
    const colors = blockColorsRef.current[blockId];
    const original = blockStyledSegments(block, colors?.glyphs);
    const base: BlockEditState = existing ?? {
      blockId,
      pageIndex: block.pageIndex,
      text: block.text,
      segments: original,
      color: colors?.ink,
      patchColor: colors?.paper ?? '#ffffff',
      patchFlat: colors?.flat ?? false,
      sampledColors: Boolean(colors),
      reflowing: false,
    };
    // A colour picked for the paragraph applies to all of it, including words that had their own.
    // Picking a one-colour paragraph's own ink again is no change at all.
    const oneInk = new Set(original.flat().map((segment) => segment.color).filter(Boolean)).size <= 1;
    const recolor: Partial<BlockEditState> = updates.color === undefined ? {}
      : updates.color === colors?.ink && oneInk ? { recolored: false }
      : { recolored: true, segments: base.segments && withoutInks(base.segments) };
    const merged: BlockEditState = { ...base, ...updates, ...recolor };
    // Stepping the size back to where it started leaves it unset, as if it was never touched.
    if (merged.fontSize !== undefined && Math.abs(merged.fontSize - block.fontSize) < 0.05) merged.fontSize = undefined;
    const next = { ...blockEditsRef.current, [blockId]: merged };
    if (merged.text === block.text && !hasParagraphRestyle(merged, colors?.ink)
      && styledTextEqual(merged.segments ?? original, original, block.fontSize)) delete next[blockId];
    replaceBlockEdits(next);
  }, [replaceBlockEdits, requestBlockPatch]);

  const addImage = async (selectedFile: File | undefined) => {
    if (!selectedFile) return;
    const generation = documentGeneration.current;
    if (!['image/png', 'image/jpeg'].includes(selectedFile.type)) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: t("edit-pdf.choose.a.png.or.jpeg.image.e86113") });
      return;
    }
    // A phone photo takes seconds to decode and shrink; the status line says so meanwhile.
    setStatus({ isProcessing: true, progress: 0, message: t("status-toast.working.on.this.device.b4ed58") });
    try {
      // Decode and re-encode first. Besides normalising EXIF orientation, this prevents unusual
      // but valid compressed PNG streams from tying up pdf-lib's pure-JavaScript decoder.
      const { file: normalizedFile, width: pixelWidth, height: pixelHeight } = await normalizeImageFileWithSize(selectedFile);
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => reject(new Error(t("edit-pdf.this.picture.could.not.be.read.try.65070d")));
        reader.readAsDataURL(normalizedFile);
      });
      if (generation !== documentGeneration.current) return;
      if (!content) throw new Error(t("edit-pdf.this.picture.could.not.be.read.try.65070d"));
      const centre = visiblePageCentre() ?? { x: 0.24, y: 0.2 };
      // The box takes the picture's own shape, so its outline and corner handle sit on the picture.
      const page = pdfZoomViewportRef.current
        ?.querySelector<HTMLElement>(`[data-pdf-page="${targetPageIndex}"]`)?.getBoundingClientRect();
      const pageAspect = page && page.height > 0 ? page.width / page.height : 1 / Math.SQRT2;
      const pictureAspect = pixelWidth > 0 && pixelHeight > 0 ? pixelWidth / pixelHeight : 1.4;
      let width = 0.28;
      let height = width * pageAspect / pictureAspect;
      if (height > 0.3) {
        height = 0.3;
        width = height * pictureAspect / pageAspect;
      }
      const newEl: EditorElement = {
        id: uuidv4(), type: 'image', pageIndex: targetPageIndex,
        x: Math.min(1 - width, Math.max(0, centre.x - width / 2)), y: Math.min(1 - height, Math.max(0, centre.y - height / 2)),
        width, height, content,
      };
      commitElements((current) => [...current, newEl]);
      setSelectedId(newEl.id);
      revealElementRef.current = newEl.id;
      setInsertMode(null);
      setStatus({ isProcessing: false, progress: 0, message: '' });
      announce(elementAdded('image', newEl.pageIndex + 1));
    } catch (error) {
      if (generation !== documentGeneration.current) return;
      setStatus({ isProcessing: false, progress: 0, message: '', error: error instanceof Error ? error.message : t("edit-pdf.this.picture.could.not.be.read.try.65070d") });
    }
  };

  const updateElement = (id: string, updates: Partial<EditorElement>) => replaceElements(elementsRef.current.map((element) => element.id === id ? { ...element, ...updates } : element));
  const commitElementUpdate = (id: string, updates: Partial<EditorElement>) => commitElements((current) => current.map((element) => element.id === id ? { ...element, ...updates } : element));
  const updateInspectorText = (id: string, content: string) => {
    if (!inspectorTextChanged.current) {
      rememberSnapshot();
      inspectorTextChanged.current = true;
    }
    updateElement(id, { content });
  };
  const finishInspectorTextChange = () => { inspectorTextChanged.current = false; };
  const deleteElement = (id: string) => {
    commitElements((current) => current.filter((element) => element.id !== id));
    setSelectedId(null);
    announce(t('edit.deleted'));
  };
  const updateFormValue = (fieldName: string, value: PdfFormFieldValue) => {
    // Typing into one field is one Undo step, like typing into a paragraph. A tick or a choice is
    // a step of its own.
    const typing = formFields.some((field) => field.fieldName === fieldName && (field.kind === 'text' || field.kind === 'textarea'));
    const session = `field:${fieldName}`;
    if (!typing || typingBlockRef.current !== session) {
      rememberSnapshot();
      if (typing) typingBlockRef.current = session;
    }
    formValuesRef.current = { ...formValuesRef.current, [fieldName]: value };
    setFormValues(formValuesRef.current);
  };

  // Save on the way out leaves only when nothing stayed behind: a paragraph the save had to skip,
  // or a locked file that only gave a preview, keeps the editor open with the save's message.
  const savedEverything = useRef(false);
  // How the last save went: a complete one is announced by the result sheet alone on a phone, and a
  // save that had to leave paragraphs out reads as a caution rather than a success.
  const [saveKind, setSaveKind] = useState<'complete' | 'partial' | 'other'>('other');
  const { ask: askToDiscard, sheet: discardSheet } = useDiscardPrompt({
    // Save is the sheet's main button, so the question is about saving.
    title: t('edit-pdf.save.your.edits'),
    save: async () => Boolean(await saveRef.current()) && savedEverything.current,
  });
  // Back, a link or the system Back with unsaved edits asks this question (the tool screen's blocker).
  useLeaveGuarded(hasUnsavedEdits, askToDiscard);

  const discardAndClose = useCallback(() => {
    if (file?.file) {
      void releaseNativePdfTextDocument(file.file);
      releaseDocumentEmbeddedFonts(file.file);
    }
    documentGeneration.current += 1;
    replacingSourceIds.current.clear();
    setPdfDoc(null);
    setFile(null);
    replaceElements([]);
    replaceBlockEdits({});
    setActiveBlockId(null);
    pageTextRef.current = new Map();
    blockIndexRef.current = new Map();
    blockColorsRef.current = {};
    setPagesWithoutText([]);
    setFormFields([]);
    setFormValues({});
    setSavedSnapshot(serializeEditorState([], {}));
    setSelectedId(null);
    setTargetPageIndex(0);
    // Each document opens fitted to the screen, not at the zoom the last one was left at.
    resetZoom();
    pdfZoomViewportRef.current?.scrollTo({ top: 0, left: 0 });
    setInsertMode(null);
    undoStack.current = [];
    redoStack.current = [];
    setHistoryVersion((value) => value + 1);
    setStatus({ isProcessing: false, progress: 0, message: '' });
  }, [file, replaceBlockEdits, replaceElements, resetZoom]);

  const closeEditor = useCallback(() => {
    if (hasUnsavedEdits) askToDiscard(discardAndClose);
    else discardAndClose();
  }, [askToDiscard, discardAndClose, hasUnsavedEdits]);

  // A PDF dropped on the open editor replaces its document, after the same question closing asks
  // (research r3, desktop-01).
  useFileDrop({ accept: file ? '.pdf,application/pdf' : '', onFiles: (files) => {
    if (status.isProcessing) return;
    const open = () => { discardAndClose(); void handleFilesSelected(files.slice(0, 1)); };
    if (hasUnsavedEdits) askToDiscard(open);
    else open();
  } });

  // The editor's history is one stack over paragraphs, annotations and shapes, so the keyboard
  // shortcut has to drive that rather than whatever a focused paragraph's own undo would do.
  // Capture phase, because the editable stops the event from reaching the document.
  const historyKeysRef = useRef({ undo: () => {}, redo: () => {} });
  historyKeysRef.current = { undo, redo };
  const saveRef = useRef<() => Promise<boolean | void> | boolean | void>(() => {});

  useEffect(() => {
    if (!file) return undefined;
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      const redoing = key === 'y' || (key === 'z' && event.shiftKey);
      if (key !== 'z' && !redoing) return;
      const target = event.target as HTMLElement | null;
      // Text fields of our own — find, replace, the inspector — keep their own undo. The phone's
      // paragraph field is the paragraph itself, so it shares the editor's history.
      if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
        && !target.dataset.fieldFor) return;
      event.preventDefault();
      if (redoing) historyKeysRef.current.redo();
      else historyKeysRef.current.undo();
    };
    document.addEventListener('keydown', handleHistoryShortcut, true);
    return () => document.removeEventListener('keydown', handleHistoryShortcut, true);
  }, [file]);

  useEffect(() => {
    if (!file) return undefined;
    const handleFindShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'f') {
        event.preventDefault();
        setFindOpen(true);
        return;
      }
      // Otherwise the browser offers to save the web page, which is never what was meant here.
      if (key === 's') {
        event.preventDefault();
        void saveRef.current();
      }
    };
    document.addEventListener('keydown', handleFindShortcut, true);
    return () => document.removeEventListener('keydown', handleFindShortcut, true);
  }, [file]);


  useEffect(() => {
    if (!isImmersiveEditor && !insertMode) return undefined;
    // Android Back arrives here as Escape. It steps out of whatever the reader is in — find, a
    // placement, a paragraph, a selected box — before it ever offers to close the document.
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // An open sheet, such as the result's actions after a save, takes Back for itself. Its own
      // listener may run after this one, so the editor must not close underneath it.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      if (findOpen) { setFindOpen(false); setFindQuery(''); }
      else if (insertMode) setInsertMode(null);
      else if (activeBlockId) {
        (document.activeElement as HTMLElement | null)?.blur();
        setActiveBlockId(null);
      } else if (selectedId) setSelectedId(null);
      else closeEditor();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [activeBlockId, closeEditor, findOpen, insertMode, isImmersiveEditor, selectedId]);

  /**
   * Work out, for each edited paragraph, whether the PDF's own text objects can express the change
   * or whether the paragraph has to be redrawn. Kept in one memo so the toolbar can tell the user
   * which of the two will happen before they ever press Save.
   */
  /**
   * Planning a paragraph measures every word of it, so doing that on each keystroke makes long
   * paragraphs type slowly on a phone. The answer only feeds the sentence under the toolbar and
   * the save, so it settles a moment after the reader stops rather than chasing every character.
   * `handleSave` recomputes from the live edits, so nothing can be saved from a stale plan.
   */
  const [settledBlockEdits, setSettledBlockEdits] = useState<Record<string, BlockEditState>>({});

  useEffect(() => {
    if (!file?.file || (!activeBlockId && Object.keys(blockEdits).length === 0)
      || documentEmbeddedFontsReady(file.file)) return;
    let active = true;
    void loadDocumentEmbeddedFonts(file.file).then(() => {
      if (active) setEmbeddedFontsVersion(version => version + 1);
    });
    return () => { active = false; };
  }, [file?.file, activeBlockId, blockEdits]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettledBlockEdits(blockEdits), PLAN_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [blockEdits]);

  useEffect(() => {
    const encountered = [...pageTextRef.current.values()].some((page) =>
      page.blocks.some((block) => hasDevanagari(block.text)))
      || (Object.values(blockEdits) as BlockEditState[]).some((edit) => hasDevanagari(edit.text));
    if (!encountered || !file?.file || (devanagariFontsReady() && documentDevanagariFontsReady(file.file))) return;
    let active = true;
    void Promise.all([loadDevanagariFonts(), loadDocumentDevanagariFonts(file.file)]).then(() => {
      if (active) { setDevanagariFontError(false); setDevanagariFontsVersion((version) => version + 1); }
    }).catch(() => {
      if (active) setDevanagariFontError(true);
    });
    return () => { active = false; };
  }, [blocksVersion, blockEdits, file?.file]);

  const buildParagraphPlans = useCallback((edits: Record<string, BlockEditState>) => {
    return (Object.values(edits) as BlockEditState[]).map((edit) => {
      const block = blockIndexRef.current.get(edit.blockId);
      if (!block) return null;
      const pageText = pageTextRef.current.get(block.pageIndex);
      const descriptor = pageText?.fonts.get(block.fontKey);
      const font = descriptor
        ? resolveFont(descriptor, edit.text, edit.fontOverride)
        : null;
      const pageBlocks = pageText?.blocks ?? [];
      // Each run is measured and glyph-checked against the face it is actually drawn in. A single
      // face chosen for the whole paragraph loses the vote to a minor one — an email address in a
      // typewriter face outweighing two serif lines — and then reports the serif letters as
      // missing glyphs, which is what pushed ordinary edits onto the redraw path.
      const runFontCache = new Map<string, { resolved: ReturnType<typeof resolveFont>; descriptor?: PdfFontDescriptor }>();
      const runFont = (fontKey: string) => {
        const cached = runFontCache.get(fontKey);
        if (cached) return cached;
        const runDescriptor = pageText?.fonts.get(fontKey);
        const entry = runDescriptor
          ? { resolved: resolveFont(runDescriptor, edit.text, edit.fontOverride), descriptor: runDescriptor }
          : { resolved: font ?? FALLBACK_RESOLVED_FONT, descriptor };
        runFontCache.set(fontKey, entry);
        return entry;
      };
      const restyled = Boolean(edit.fontOverride?.klass)
        || edit.fontOverride?.bold != null
        || edit.fontOverride?.italic != null
        || (edit.fontSize !== undefined && edit.fontSize !== block.fontSize)
        || edit.recolored === true
        || (edit.color !== undefined && edit.color !== blockColorsRef.current[edit.blockId]?.ink);
      const rotated = Math.abs(block.angle) > 0.02;
      const devanagari = hasDevanagari(block.text) || hasDevanagari(edit.text);
      const preserveOriginal = !edit.fontOverride?.klass
        && edit.fontOverride?.bold == null && edit.fontOverride?.italic == null;
      const lines = edit.segments ?? edit.text.split('\n').map((line) => [{ text: line, fontKey: block.fontKey }]);
      const embeddedFor = (fontKey: string, text: string) => preserveOriginal
        ? matchingSimpleEmbeddedPdfFont(file?.file, pageText?.fonts.get(fontKey)?.psName, text) : null;
      const devanagariId = selectDevanagariFont(
        file?.file, descriptor?.psName, edit.text,
        edit.fontOverride?.klass ?? font?.klass ?? 'sans-serif', edit.fontOverride?.bold ?? descriptor?.bold ?? false,
        preserveOriginal,
      );
      const planned: BlockEditPlan = devanagari
        ? rotated
          ? { mode: 'blocked', reason: t("edit-pdf.rotated.or.skewed.text.cannot.be.redrawn.14e7bb") }
          : { mode: 'reflow', reason: 'Devanagari text needs shaped font export' }
        : restyled
        // Restyling changes every glyph on the line, which no in-place text rewrite can express.
        ? rotated
          ? { mode: 'blocked', reason: t("edit-pdf.rotated.or.skewed.text.cannot.be.restyled.258b98") }
          : { mode: 'reflow', reason: t("edit-pdf.the.paragraph.s.typeface.size.or.colour.35605c") }
        : planBlockEdit(block, edit.text, {
          segments: edit.segments,
          inks: blockColorsRef.current[block.id]?.glyphs,
          measure: (text: string, fontSize: number, fontKey: string) =>
            measureTextWidth(text, runFont(fontKey).resolved, fontSize),
          maxU: Math.min(pageText?.pageWidth ?? Infinity, block.left + block.measure),
          canDraw: (text, fontKey) => {
            const face = pageText?.fonts.get(fontKey);
            const coverage = face ? checkGlyphCoverage(face, text) : null;
            return !coverage?.checked || coverage.covered;
          },
        });

      const original = new Set(block.text);
      const introduced = [...new Set(edit.text)].filter((character) => !original.has(character)).join('');
      const plan = planned;
      if (devanagari && (!devanagariFontsReady() || !canShapeDevanagari(edit.text, devanagariId))) {
        return {
          edit, block,
          plan: { mode: 'blocked' as const, reason: devanagariFontError
            ? 'The Devanagari fonts could not be loaded.'
            : !devanagariFontsReady()
              ? 'Loading Devanagari fonts…'
              : 'The selected Devanagari font cannot draw part of this paragraph.' },
          font, descriptor, reflow: null,
        };
      }
      // A usable original font can draw characters the standard fallback cannot encode.
      const unencodable = devanagari ? [] : plan.mode === 'reflow'
        ? lines.flatMap(line => line.flatMap(segment => embeddedFor(segment.fontKey, segment.text)
          ? [] : unencodableCharacters(segment.text, FALLBACK_RESOLVED_FONT)))
        : unencodableCharacters(introduced, font ?? FALLBACK_RESOLVED_FONT, descriptor);
      if (unencodable.length > 0) {
        // A character the reader typed is their choice to change. One that was already in the
        // paragraph means only the document's own font can draw it, and a redraw cannot.
        const typed = unencodable.filter((character) => !original.has(character));
        return {
          edit,
          block,
          plan: {
            mode: 'blocked' as const,
            reason: typed.length > 0
              ? t("edit-pdf.no.font.available.here.can.draw.324959", { v0: describeCharacters(typed) })
              : t("edit-pdf.this.paragraph.contains.which.only.the.pdf.6a8392", { v0: describeCharacters(unencodable) }),
          },
          font,
          descriptor,
          reflow: null,
        };
      }

      if (plan.mode !== 'reflow') return { edit, block, plan, font, descriptor, reflow: null };
      const resolvedPlan: BlockEditPlan = plan;

      const resolved = devanagari ? {
        mode: devanagariId.startsWith('Embedded') ? 'embedded' as const : 'substituted' as const,
        cssFamily: devanagariCssFamily(devanagariId),
        cssWeight: '400', cssStyle: 'normal',
        klass: font?.klass ?? 'sans-serif' as const,
        reason: devanagariId.startsWith('Embedded') ? null : devanagariId.startsWith('Martel') ? 'Martel' : 'Mukta',
        missingGlyphs: [],
      } : font ?? FALLBACK_RESOLVED_FONT;
      const fontSize = edit.fontSize ?? block.fontSize;
      const lineHeight = Math.max(fontSize, block.leading * (fontSize / block.fontSize));
      // Colour and size changes still keep each run's original typeface.
      const faceFor = (fontKey: string) => (!preserveOriginal || !fontKey
        ? { descriptor, resolved }
        : runFont(fontKey));
      const toFace = (fontKey: string, text = edit.text): ParagraphFace => {
        const face = faceFor(fontKey);
        if (devanagari) return {
          key: fontKey || block.fontKey,
          family: selectDevanagariFont(
            file?.file, face.descriptor?.psName, edit.text,
            edit.fontOverride?.klass ?? face.resolved.klass,
            edit.fontOverride?.bold ?? face.descriptor?.bold ?? false,
            preserveOriginal,
          ),
          bold: edit.fontOverride?.bold ?? face.descriptor?.bold ?? false,
          italic: edit.fontOverride?.italic ?? face.descriptor?.italic ?? false,
        };
        return {
          key: fontKey || block.fontKey,
          family: face.resolved.klass === 'serif' ? 'TimesRoman'
            : face.resolved.klass === 'monospace' ? 'Courier' : 'Helvetica',
          bold: edit.fontOverride?.bold ?? face.descriptor?.bold ?? face.resolved.cssWeight === '700',
          italic: edit.fontOverride?.italic ?? face.descriptor?.italic ?? face.resolved.cssStyle === 'italic',
          embeddedFontId: embeddedFor(fontKey, text) ?? undefined,
        };
      };
      // A redraw changes how the PDF stores the text, not where its line breaks belong.
      // Use the same explicit rows as contentEditable, even when a line exceeds its old width.
      if (devanagari && lines.some((line) => line.some((segment) =>
        !canShapeDevanagari(segment.text, toFace(segment.fontKey).family as DevanagariFontId)))) {
        return {
          edit, block, plan: { mode: 'blocked' as const, reason: 'No available Devanagari font can draw this paragraph.' },
          font: resolved, descriptor, reflow: null,
        };
      }
      // A line that outgrows the paragraph wraps inside its width, as it would in any editor, and
      // the breaks its author made stay. A one-line paragraph may first grow to the page's right
      // margin or the next text on its row. Right-to-left and Devanagari text keep explicit rows.
      const measureSegment = (text: string, segment: StyledSegment) => {
        const size = (segment.fontSize ?? block.fontSize) * fontSize / block.fontSize;
        try {
          return measureParagraphText(text, toFace(segment.fontKey, segment.text), size);
        } catch {
          return text.length * size * 0.5;
        }
      };
      const wrapWidth = (() => {
        if (block.lines.length > 1) return block.measure;
        const pageWidth = pageText?.pageWidth ?? block.left + block.measure;
        // The right margin mirrors the page's left one, but never more than an inch: on a page whose
        // only text sits on the right, the mirror would leave no room at all.
        const leftMargin = Math.min(72, block.left, ...pageBlocks.map((candidate) => candidate.left));
        // A word is never cut while it still fits before the page's edge, unless text beside it
        // on the same row is in the way.
        let edge = pageWidth - block.left - block.fontSize;
        let room = pageWidth - leftMargin - block.left;
        pageBlocks.forEach((candidate) => {
          const sameRows = candidate.top < block.top + block.height && candidate.top + candidate.height > block.top;
          if (candidate.id !== block.id && sameRows && candidate.left >= block.left + block.width - 1) {
            room = Math.min(room, candidate.left - block.left - block.fontSize * 0.5);
            edge = Math.min(edge, room);
          }
        });
        const widestWord = Math.max(0, ...lines.flat().flatMap((segment) => segment.text.split(/\s+/)
          .filter(Boolean).map((word) => measureSegment(word, segment))));
        return Math.max(block.measure, room, Math.min(widestWord, edge));
      })();
      // Rows spaced unevenly, such as a table column, are not one flowing paragraph: wrapping would
      // put every row on one pitch and move rows nobody edited.
      const pitches = block.lines.slice(1).map((line, index) => Math.abs(line.v - block.lines[index].v));
      const evenRows = pitches.length === 0 || Math.max(...pitches) <= Math.min(...pitches) * 1.15;
      const flowed = devanagari || block.direction === 'rtl' || !evenRows ? lines
        : flowStyledLines(lines, measureSegment, wrapWidth,
          lines.map(styledLineText).join('\n') === edit.text ? edit.softBreaks : undefined);
      const lineOrigins = paragraphLineOrigins(block, flowed.length, fontSize);
      const height = flowed.length === block.lines.length && fontSize === block.fontSize
        ? block.height
        : Math.max(block.height, (lineOrigins.at(-1)?.y ?? 0) + fontSize * 0.3);
      // Redrawing does not push the rest of the page down, so a paragraph that outgrows its own
      // space lands on whatever follows it. That has to be said out loud, not discovered on save.
      const next = pageBlocks.find((candidate) => (
        candidate.id !== block.id
        && candidate.top >= block.top + block.height
        && candidate.left < block.left + block.measure
        && candidate.left + candidate.width > block.left
      ));
      const available = next ? next.top - block.top : (pageText?.pageHeight ?? block.top + height) - block.top;

      return {
        edit,
        block,
        plan: resolvedPlan,
        font: devanagari ? resolved : font,
        descriptor,
        reflow: { resolved, faceFor, toFace, fontSize, lineHeight, lines: flowed, lineOrigins, height, overrun: Math.max(0, height - available), devanagari },
      };
    }).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .filter((entry) => entry.plan.mode !== 'unchanged');
  }, [devanagariFontError, file?.file, embeddedFontsVersion]);

  /**
   * Fetch a paragraph's background only when something will actually draw it.
   *
   * Direct edits need this for their on-screen preview too. Limit those to the visible page, so a
   * whole-document replacement does not render every page just to prepare invisible previews.
   */
  const patchQueueRef = useRef<PdfTextBlock[]>([]);
  const patchDrainingRef = useRef(false);
  const [pendingPatches, setPendingPatches] = useState(0);

  const enqueueBlockPatch = useCallback((block: PdfTextBlock) => {
    if (patchQueueRef.current.some((queued) => queued.id === block.id)) return;
    patchQueueRef.current.push(block);
    setPendingPatches(patchQueueRef.current.length);
    if (patchDrainingRef.current) return;
    patchDrainingRef.current = true;

    const yieldThen = (run: () => void) => {
      const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => void }).requestIdleCallback;
      if (idle) idle(run, { timeout: 250 });
      else window.setTimeout(run, 0);
    };

    const drain = () => {
      const next = patchQueueRef.current.shift();
      setPendingPatches(patchQueueRef.current.length);
      if (!next) {
        patchDrainingRef.current = false;
        return;
      }
      void requestBlockPatch(next).finally(() => yieldThen(drain));
    };
    yieldThen(drain);
  }, [requestBlockPatch]);

  const paragraphPlans = useMemo(
    () => {
      void blocksVersion;
      return buildParagraphPlans(settledBlockEdits);
    },
    [blocksVersion, buildParagraphPlans, settledBlockEdits, locale, devanagariFontsVersion],
  );

  const blockPreviews = useMemo(() => {
    const previews: Record<string, BlockTextPreview> = {};
    paragraphPlans.forEach(({ edit, block, plan, reflow }) => {
      if (plan.mode === 'blocked') return;
      const width = Math.max(block.width, block.measure);
      if (reflow) {
        const lines = reflow.lines.map((line) => line.map((segment) => ({
          text: segment.text, face: reflow.toFace(segment.fontKey, segment.text),
          fontSize: (segment.fontSize ?? block.fontSize) * reflow.fontSize / block.fontSize,
          color: segment.color,
        })));
        previews[block.id] = {
          text: edit.text, reflow: true, width, height: reflow.height,
          pieces: layoutParagraphLines(lines, {
            width, fontSize: reflow.fontSize, lineHeight: reflow.lineHeight, align: block.align,
            lineOrigins: reflow.lineOrigins,
            measure: reflow.devanagari
              ? (text, face, size) => measureDevanagariText(text, face.family as DevanagariFontId, size)
              : undefined,
            normalizeText: reflow.devanagari ? (text) => text.replace(/\t/g, '    ') : undefined,
          }).map((piece) => {
            // Save always writes with the embedded program. The screen uses it only when the
            // browser was given it; otherwise the nearest standard family stands in.
            const embedded = piece.face.embeddedFontId ? embeddedPdfFont(piece.face.embeddedFontId) : undefined;
            const ownFamily = embedded?.browserFace ? embedded.cssFamily : null;
            return { ...piece, spans: piece.color ? [{ text: piece.text, color: piece.color }] : undefined, font: {
              ...FALLBACK_RESOLVED_FONT,
              cssFamily: ownFamily ? `"${ownFamily}", sans-serif`
                : reflow.devanagari ? devanagariCssFamily(piece.face.family as DevanagariFontId)
                : piece.face.family === 'TimesRoman' ? '"Times New Roman", Times, serif'
                : piece.face.family === 'Courier' ? '"Courier New", Courier, monospace' : 'Arial, Helvetica, sans-serif',
              cssWeight: reflow.devanagari || ownFamily ? '400' : piece.face.bold ? '700' : '400',
              cssStyle: ownFamily ? 'normal' : piece.face.italic ? 'italic' : 'normal',
            } };
          }),
        };
      } else if (plan.mode === 'direct') {
        const replacements = new Map(plan.runEdits.map((run) => [run.itemIndex, run.replacementText]));
        const u0 = Math.min(...block.lines.map((line) => line.u0));
        const fonts = pageTextRef.current.get(block.pageIndex)?.fonts;
        previews[block.id] = {
          text: edit.text, reflow: false, width, height: block.height,
          pieces: block.lines.flatMap((line, lineIndex) => {
            // The edited line's characters line up with its runs' replacements, so each run takes
            // its own stretch of the line's colours.
            const inks = edit.segments?.[lineIndex] && segmentInks(edit.segments[lineIndex]);
            let offset = 0;
            return line.runs.map((run) => {
              const descriptor = fonts?.get(run.fontKey);
              const font = descriptor ? resolveFont(descriptor, run.text) : FALLBACK_RESOLVED_FONT;
              const text = replacements.get(run.itemIndex) ?? run.text;
              const spans = inks ? splitByInk(text, inks.slice(offset, offset + text.length)) : undefined;
              offset += text.length;
              return {
                text, x: run.u0 - u0, y: line.v - block.lines[0].v + block.ascent,
                width: Math.max(0, run.u1 - run.u0 + measureTextWidth(text, font, run.fontSize)
                  - measureTextWidth(run.text, font, run.fontSize)),
                font, fontSize: run.fontSize, lineIndex, spans,
              };
            });
          }),
        };
      }
    });
    return previews;
  }, [paragraphPlans]);

  const activePlan = activeBlockId
    ? paragraphPlans.find((entry) => entry.edit.blockId === activeBlockId) ?? null
    : null;

  useEffect(() => {
    paragraphPlans.forEach(({ edit, block, plan }) => {
      if (plan.mode === 'blocked' || edit.patch) return;
      if (plan.mode === 'direct' && block.pageIndex !== targetPageIndex) return;
      // Unknown means the page was never drawn, so its colours were never sampled. A flat fill in
      // the paper colour is the honest answer there, not a page render nobody asked for.
      if (!edit.sampledColors) return;
      enqueueBlockPatch(block);
    });
  }, [enqueueBlockPatch, paragraphPlans, targetPageIndex]);

  const blockedParagraphs = useMemo(
    () => paragraphPlans
      .filter((entry) => entry.plan.mode === 'blocked')
      .sort((first, second) => first.block.pageIndex - second.block.pageIndex || first.block.top - second.block.top),
    [paragraphPlans],
  );
  const [blockedReviewIndex, setBlockedReviewIndex] = useState(0);

  /** Walk the paragraphs that cannot be written, one press at a time. */
  const reviewNextBlockedParagraph = useCallback(() => {
    if (blockedParagraphs.length === 0) return;
    const entry = blockedParagraphs[blockedReviewIndex % blockedParagraphs.length];
    setBlockedReviewIndex((current) => (current + 1) % blockedParagraphs.length);
    setTargetPageIndex(entry.block.pageIndex);
    let attempts = 0;
    const reveal = () => {
      const element = document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(entry.block.id)}"]`);
      if (element) {
        setActiveBlockId(entry.block.id);
        element.focus({ preventScroll: true });
        const viewport = pdfZoomViewportRef.current;
        if (viewport) scrollBlockIntoViewport(viewport, element);
        return;
      }
      if (attempts < 40) {
        attempts += 1;
        window.requestAnimationFrame(reveal);
      }
    };
    window.requestAnimationFrame(reveal);
  }, [blockedParagraphs, blockedReviewIndex]);

  const revertBlockedParagraphs = useCallback(() => {
    if (blockedParagraphs.length === 0) return;
    rememberSnapshot();
    const next = { ...blockEditsRef.current };
    blockedParagraphs.forEach((entry) => delete next[entry.edit.blockId]);
    replaceBlockEdits(next);
    setBlockedReviewIndex(0);
  }, [blockedParagraphs, replaceBlockEdits]);

  const buildParagraphSaveEdits = useCallback((
    { forceReflow = false, plans = paragraphPlans }: {
      /** True for every paragraph, or the ids of the ones that must be redrawn rather than rewritten. */
      forceReflow?: boolean | ReadonlySet<string>;
      plans?: typeof paragraphPlans;
    } = {},
  ): ParagraphSaveEdit[] => (
    plans.flatMap(({ edit, block, plan, descriptor, reflow }) => {
      const redrawThisOne = typeof forceReflow === 'boolean' ? forceReflow : forceReflow.has(edit.blockId);
      // A paragraph the file cannot express is left exactly as the document wrote it. Refusing the
      // whole save instead would throw away every other edit — and on a long document that is
      // thousands of them, discarded because of one character on one page.
      if (plan.mode === 'blocked') return [];
      if (plan.mode === 'direct' && !redrawThisOne) {
        return [{ mode: 'direct' as const, pageIndex: block.pageIndex, runEdits: plan.runEdits }];
      }

      const pageText = pageTextRef.current.get(block.pageIndex);
      const pageWidth = pageText?.pageWidth ?? block.left + block.measure;
      const pageHeight = pageText?.pageHeight ?? block.top + block.height;
      const resolved = reflow?.resolved ?? FALLBACK_RESOLVED_FONT;
      const devanagari = reflow?.devanagari ?? false;
      const fontSize = reflow?.fontSize ?? edit.fontSize ?? block.fontSize;
      const lineHeight = reflow?.lineHeight ?? Math.max(fontSize, block.leading);
      const faceFor = reflow?.faceFor ?? ((fontKey: string) => {
        const runDescriptor = pageText?.fonts.get(fontKey) ?? descriptor;
        return { descriptor: runDescriptor, resolved: runDescriptor
          ? resolveFont(runDescriptor, edit.text, edit.fontOverride) : resolved };
      });
      const toFace = (fontKey: string, text: string): ParagraphFace => {
        const face = faceFor(fontKey);
        if (devanagari) return {
          key: `${fontKey || block.fontKey}:devanagari`,
          family: selectDevanagariFont(
            file?.file, face.descriptor?.psName, edit.text,
            edit.fontOverride?.klass ?? face.resolved.klass,
            edit.fontOverride?.bold ?? face.descriptor?.bold ?? false,
            !edit.fontOverride?.klass && edit.fontOverride?.bold == null && edit.fontOverride?.italic == null,
          ),
          bold: edit.fontOverride?.bold ?? face.descriptor?.bold ?? false,
          italic: edit.fontOverride?.italic ?? face.descriptor?.italic ?? false,
        };
        return {
          key: `${fontKey || block.fontKey}:${face.resolved.mode}:${face.resolved.klass}:${face.resolved.cssWeight}:${face.resolved.cssStyle}`,
          family: face.resolved.klass === 'serif'
            ? 'TimesRoman'
            : face.resolved.klass === 'monospace'
              ? 'Courier'
              : 'Helvetica',
          // Read from the document's own record of the face, not from the CSS the overlay uses:
          // when the real bold face is available the overlay draws with it directly and asks for
          // no extra weight, so the CSS weight is 'normal' on text that is plainly bold.
          bold: edit.fontOverride?.bold ?? face.descriptor?.bold ?? face.resolved.cssWeight === '700',
          italic: edit.fontOverride?.italic ?? face.descriptor?.italic ?? face.resolved.cssStyle === 'italic',
          embeddedFontId: !edit.fontOverride?.klass && edit.fontOverride?.bold == null && edit.fontOverride?.italic == null
            ? matchingSimpleEmbeddedPdfFont(file?.file, face.descriptor?.psName, text) ?? undefined : undefined,
        };
      };
      const segments = reflow?.lines ?? edit.segments
        ?? edit.text.split('\n').map((line) => [{ text: line, fontKey: block.fontKey }]);
      const lines = segments.map((line) => line.map((segment) => ({
        text: segment.text, face: toFace(segment.fontKey, segment.text),
        fontSize: (segment.fontSize ?? block.fontSize) * fontSize / block.fontSize,
        color: segment.color,
      })));

      return [{
        mode: 'reflow' as const,
        script: devanagari ? 'devanagari' as const : undefined,
        pageIndex: block.pageIndex,
        x: block.left / pageWidth,
        y: block.top / pageHeight,
        width: Math.max(block.width, block.measure) / pageWidth,
        // A fallback background covers only the original area; growing text must not stretch
        // table rules or paint out a larger part of the page.
        height: block.height / pageHeight,
        // Every source run in the paragraph is removed before the redraw, so the file never keeps
        // words that are no longer on the page.
        runDeletions: block.lines.flatMap((line) => line.runs.flatMap((run) => (
          // A run that draws only spacing leaves no ink to remove, and matching a whitespace-only
          // text object against the PDF engine is unreliable enough to fail the whole deletion.
          run.sourcePdfRect && run.sourceText?.trim()
            ? [{ sourceText: run.sourceText, sourcePdfRect: run.sourcePdfRect }]
            : []
        ))),
        backgroundImage: edit.patch ?? blockEditsRef.current[edit.blockId]?.patch,
        backgroundColor: edit.patchColor ?? '#ffffff',
        backgroundFlat: edit.patchFlat ?? false,
        highlight: blockColorsRef.current[edit.blockId]?.highlight,
        lines,
        lineOrigins: reflow?.lineOrigins ?? paragraphLineOrigins(block, lines.length, fontSize),
        fontSize,
        lineHeight,
        align: block.align,
        color: edit.color ?? '#000000',
        colorsSampled: edit.recolored !== true && edit.sampledColors !== false,
      }];
    })
  ), [paragraphPlans]);

  const handleSave = async () => {
    if (!file || saveInProgress.current) return;
    saveInProgress.current = true;
    const generation = documentGeneration.current;
    const savingElements = elementsRef.current;
    const savingFormValues = formValues;
    const savingBlockEdits = blockEditsRef.current;
    setStatus({ isProcessing: true, progress: 20, message: t("edit-pdf.saving.pdf.edits.locally.3dbf9d") });
    try {
      let bytes: Uint8Array;
      /** Set when the in-place rewrite was planned but did not hold, and paragraphs were redrawn. */
      let fallbackReason = '';
      // Planned from the live edits rather than the settled ones: a save can arrive inside the
      // window where the last keystroke has not been planned yet.
      const needsDevanagari = (Object.values(savingBlockEdits) as BlockEditState[]).some((edit) =>
        hasDevanagari(edit.text) || hasDevanagari(blockIndexRef.current.get(edit.blockId)?.text ?? ''));
      if (needsDevanagari) await Promise.all([loadDevanagariFonts(), loadDocumentDevanagariFonts(file.file)]);
      if (generation !== documentGeneration.current) return;
      if (Object.keys(savingBlockEdits).length > 0) await loadDocumentEmbeddedFonts(file.file);
      if (generation !== documentGeneration.current) return;
      let plans = buildParagraphPlans(savingBlockEdits);

      // In-place edits also need the actual font's glyph coverage. Replace-all can touch pages
      // nobody opened, so read every edited page's pending fonts before deciding what to save.
      const pagesNeedingFonts = [...new Set(plans
        .map((entry) => entry.block.pageIndex as number))]
        .filter((pageIndex) => [...(pageTextRef.current.get(pageIndex)?.fonts.values() ?? [])]
          .some((descriptor) => descriptor.resolution === 'pending'));

      if (pagesNeedingFonts.length > 0 && pdfDoc) {
        setStatus({
          isProcessing: true,
          progress: 30,
          message: t("edit-pdf.reading.the.fonts.on.77f2bf", { count: pagesNeedingFonts.length }),
        });
        let upgraded = false;
        for (const pageIndex of pagesNeedingFonts as number[]) {
          const pageText = pageTextRef.current.get(pageIndex);
          if (!pageText) continue;
          if (await resolvePageFonts(pdfDoc, pageIndex, pageText.fonts)) upgraded = true;
          if (generation !== documentGeneration.current) return;
        }
        if (upgraded) {
          resetFontResolutionCaches();
          plans = buildParagraphPlans(savingBlockEdits);
        }
      }
      const blockedPlans = plans.filter((entry) => entry.plan.mode === 'blocked');
      const savablePlans = plans.filter((entry) => entry.plan.mode !== 'blocked');
      // Narrowed if the rewrite has to fall back to redrawing, which not every paragraph can do.
      const redrawable = new Set<(typeof paragraphPlans)[number]>(savablePlans);
      if (savablePlans.length === 0 && blockedPlans.length > 0) {
        throw refusal(describeBlockedParagraphs(blockedPlans));
      }
      // A direct rewrite does not use preview pixels. If it later needs a background fallback,
      // that path explicitly awaits requestBlockPatch; pending previews need not delay Save.
      if (savablePlans.some((entry) => entry.plan.mode === 'reflow')) {
        if (patchQueueRef.current.length > 0 || patchDrainingRef.current) {
          setStatus({ isProcessing: true, progress: 15, message: t("edit-pdf.getting.the.page.ready.3d8730") });
          while (patchQueueRef.current.length > 0 || patchDrainingRef.current) {
            await new Promise((resolve) => window.setTimeout(resolve, 60));
            if (generation !== documentGeneration.current) return;
          }
        }
      }
      try {
        bytes = await savePDFWithAnnotations(file.file, savingElements, savingFormValues, buildParagraphSaveEdits({ plans: savablePlans }));
      } catch (directEditError) {
        // Rewriting a PDF's own text objects needs PDF.js and the PDF engine to agree on what the
        // text says, and ligatures and custom encodings sometimes make them disagree. That only
        // surfaces here, so rather than losing the edit, redraw the affected paragraphs over the
        // original words instead of through them — and say that is what happened.
        if (!isDirectEditFailure(directEditError) || savablePlans.length === 0) throw directEditError;
        // The paragraph inspector said these would be rewritten in place. They were not, and a
        // redraw is a visibly different thing to have done to someone's document, so the reason
        // is kept and reported rather than letting the save look like the promised one.
        fallbackReason = directEditError.message.replace(/^Direct text edit failed:\s*/, '');
        // eslint-disable-next-line no-console
        console.warn('Paragraph redrawn instead of edited in place:', fallbackReason);

        /** Asks whether a group of paragraphs saves on its own. Annotations and form values are left out. */
        const savesAlone = (forceReflow: ReadonlySet<string>) => async (group: typeof savablePlans) => {
          if (generation !== documentGeneration.current) return true;
          try {
            await savePDFWithAnnotations(file.file, [], {}, buildParagraphSaveEdits({ forceReflow, plans: group }));
            return true;
          } catch (error) {
            if (!isDirectEditFailure(error)) throw error;
            return false;
          }
        };
        /** Leaves paragraphs unsaved, never drawn over their old words, where a search would still find them. */
        const keepUnsaved = (entries: typeof savablePlans, reason: string) => entries.forEach((entry) => {
          if (!redrawable.delete(entry)) return;
          blockedPlans.push({ ...entry, plan: { mode: 'blocked', reason } });
        });

        // The save offers every paragraph to the PDF engine at once, so one it will not take fails
        // the whole call. Halving the set finds the ones that refuse, and only those change course:
        // a rewrite in place is redrawn instead, and a redraw whose old words cannot be removed
        // stays unsaved.
        setStatus({ isProcessing: true, progress: 45, message: t("edit-pdf.working.out.which.paragraphs.can.still.be.b63bec") });
        const refused = await findRefusingItems<(typeof savablePlans)[number]>(savablePlans, savesAlone(new Set()));
        if (generation !== documentGeneration.current) return;
        const stubborn = new Set(refused.filter((entry) => entry.plan.mode === 'direct').map((entry) => entry.edit.blockId));
        keepUnsaved(refused.filter((entry) => entry.plan.mode !== 'direct'), fallbackReason);

        // Check the faces that will actually redraw each stretch, including original fonts.
        const willRedraw = savablePlans.filter(
          (entry) => redrawable.has(entry) && (entry.plan.mode !== 'direct' || stubborn.has(entry.edit.blockId)),
        );
        willRedraw.forEach((entry) => {
          const keepsFace = !entry.edit.fontOverride?.klass
            && entry.edit.fontOverride?.bold == null && entry.edit.fontOverride?.italic == null;
          const segments = entry.reflow?.lines ?? entry.edit.segments
            ?? entry.edit.text.split('\n').map(text => [{ text, fontKey: entry.block.fontKey }]);
          const characters = entry.reflow?.devanagari ? [] : segments.flatMap(line => line.flatMap(segment => {
            const face = pageTextRef.current.get(entry.block.pageIndex)?.fonts.get(segment.fontKey);
            return keepsFace && matchingSimpleEmbeddedPdfFont(file.file, face?.psName, segment.text)
              ? [] : unencodableCharacters(segment.text, FALLBACK_RESOLVED_FONT);
          }));
          const rotated = Math.abs(entry.block.angle) > 0.02;
          if (characters.length === 0 && !rotated) return;
          keepUnsaved([entry], rotated
            ? t("edit-pdf.rotated.or.skewed.text.cannot.be.redrawn.14e7bb")
            : t("edit-pdf.it.contains.which.only.this.pdf.s.a5b6c7", { v0: describeCharacters(characters) }));
        });
        if (redrawable.size === 0) {
          throw refusal(describeBlockedParagraphs(blockedPlans));
        }
        setStatus({ isProcessing: true, progress: 60, message: t("edit-pdf.redrawing.the.edited.paragraphs.instead.6f9592") });
        const saveRedrawn = () => savePDFWithAnnotations(
          file.file,
          savingElements,
          savingFormValues,
          buildParagraphSaveEdits({ forceReflow: stubborn, plans: [...redrawable] }),
        );
        try {
          bytes = await saveRedrawn();
        } catch (redrawError) {
          if (!isDirectEditFailure(redrawError)) throw redrawError;
          const stillRefused = await findRefusingItems<(typeof savablePlans)[number]>([...redrawable], savesAlone(stubborn));
          if (generation !== documentGeneration.current) return;
          keepUnsaved(stillRefused, redrawError.message.replace(/^Direct text edit failed:\s*/, ''));
          if (redrawable.size === 0) {
            throw refusal(describeBlockedParagraphs(blockedPlans));
          }
          bytes = await saveRedrawn();
        }
      }
      if (generation !== documentGeneration.current) return;
      const delivery = await deliverBlob(new Blob([bytes], { type: 'application/pdf' }), toolOutputName('edit', file.name, 'pdf'));
      if (generation !== documentGeneration.current) return;
      if (delivery.status === 'preview') {
        setStatus({
          isProcessing: false,
          progress: 100,
          message: t("edit-pdf.edited.pdf.preview.ready.unlock.to.save.3b563b"),
        });
        savedEverything.current = false;
        setSaveKind('other');
        return true;
      }
      // Anything that was not written stays dirty, so the leave-guard still protects it and the
      // notice still points at it. Marking the whole document clean would quietly discard it.
      const skipped = new Set(blockedPlans.map((entry) => entry.edit.blockId));
      const savedBlockEdits = Object.fromEntries(
        (Object.entries(savingBlockEdits) as Array<[string, BlockEditState]>)
          .filter(([blockId]) => !skipped.has(blockId)),
      );
      setSavedSnapshot(serializeEditorState(savingElements, savingFormValues, savedBlockEdits));
      setStatus({
        isProcessing: false,
        progress: 100,
        message: blockedPlans.length > 0
          ? t("edit-pdf.edited.pdf.ready.with.of.edited.paragraphs.cab23a", { v0: (plans.length - blockedPlans.length).toLocaleString(getLocale()), v1: plans.length.toLocaleString(getLocale()), v2: describeBlockedParagraphs(blockedPlans), count: blockedPlans.length })
          // The internal reason is left out. It names the part of the PDF that would not
          // cooperate, which tells the reader nothing they can act on. It is logged for support.
          : fallbackReason
          ? t("edit-pdf.edited.pdf.ready.the.paragraphs.you.changed.9cebe8")
          : t("edit-pdf.edited.pdf.ready.review.it.before.sharing.0b2900"),
      });
      savedEverything.current = blockedPlans.length === 0;
      setSaveKind(blockedPlans.length > 0 ? 'partial' : fallbackReason ? 'other' : 'complete');
      return true;
    } catch (error) {
      if (generation !== documentGeneration.current) return;
      if (error instanceof PdfTextBoxError) {
        const element = savingElements.find((item) => item.id === error.elementId);
        if (element) {
          setTargetPageIndex(element.pageIndex);
          setSelectedId(element.id);
          setActiveBlockId(null);
        }
        setStatus({ isProcessing: false, progress: 0, message: '', error: localizeError(error) });
        return;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        setStatus({ isProcessing: false, progress: 0, message: t("edit-pdf.save.cancelled.your.edits.are.still.here.433678") });
        return;
      }
      const message = error instanceof Error ? error.message : '';
      const chosen = error instanceof Error && error.name === 'PdfChefRefusal';
      // A refusal we chose to make is an answer, not a fault, so it does not go to the console.
      if (!chosen && message !== english['error.pdfEditPermission']) {
        console.error(error);
      }
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: chosen
          || message === PDF_TEXT_OVERFLOW_MESSAGE
          || message === english['error.pdfEditPermission']
          || message.startsWith('Visual fallback is unavailable')
          ? error instanceof Error ? localizeError(error) : message
          : message.startsWith('Direct text edit failed:')
          ? t("edit-pdf.your.edits.are.still.here.1314a7", { v0: error instanceof Error ? localizeError(error) : message })
          : t("edit-pdf.unable.to.save.the.edited.pdf.your.5e2dde"),
      });
    } finally {
      saveInProgress.current = false;
    }
  };

  const activeBlock = activeBlockId ? blockIndexRef.current.get(activeBlockId) ?? null : null;
  const activeBlockDescriptor = activeBlock
    ? pageTextRef.current.get(activeBlock.pageIndex)?.fonts.get(activeBlock.fontKey)
    : undefined;
  const activeBlockEdit = activeBlockId ? blockEdits[activeBlockId] : undefined;
  // On a phone, Find and the paragraph panel are one dock, never stacked: with the keyboard up the
  // two together left the page a line tall. Opening Find steps out of the paragraph; tapping a
  // match to edit it hides Find until Done, and Find comes back where it was.
  const findSharesDock = isImmersiveEditor && Boolean(activeBlockId);
  const toggleFind = () => {
    if (findOpen && !findSharesDock) {
      setFindOpen(false);
      setFindQuery('');
      return;
    }
    if (findSharesDock) {
      (document.activeElement as HTMLElement | null)?.blur();
      setActiveBlockId(null);
    }
    setFindOpen(true);
  };
  const findBar = findOpen && !findSharesDock ? (
    <PdfFindReplace
      query={findQuery}
      replacement={findReplacement}
      caseSensitive={findCaseSensitive}
      matchCount={findMatches.length}
      activeMatch={findIndex}
      scanning={findScanning}
      showReplace={findShowReplace}
      compact={compactViewport}
      report={findReport}
      onQueryChange={(value) => { setFindQuery(value); setFindIndex(0); setFindReport(''); shownMatchRef.current = null; }}
      onReplacementChange={(value) => { setFindReplacement(value); setFindReport(''); }}
      onCaseSensitiveChange={setFindCaseSensitive}
      onShowReplaceChange={setFindShowReplace}
      onStep={stepMatch}
      onReplaceOne={replaceCurrentMatch}
      onReplaceAll={replaceAllMatches}
      onClose={() => {
        setFindOpen(false); setFindQuery(''); setFindReport('');
        if (!activeBlockId && autoZoomRef.current) {
          const { from } = autoZoomRef.current;
          autoZoomRef.current = null;
          setExactZoom(from);
        }
      }}
    />
  ) : null;

  // A page whose text is part of a scan has nothing to edit and no reason why, which reads as the
  // editor being broken. Say what the page is and point at the tool that fixes it.
  const scannedNotice = pagesWithoutText.includes(targetPageIndex) ? (
    <div role="status" className={compactViewport ? 'mx-auto mb-2 max-w-md' : 'mb-2'}>
      <StatusLine tone="caution">
        {t('editor.scan.useOcr', { page: targetPageIndex + 1, tool: '\uFFFC' }).split('\uFFFC').map((part, index) => (
          <React.Fragment key={index}>
            {index > 0 && <Link to="/ocr" className="font-bold underline">{t('edit-pdf.extract.text.9ab592')}</Link>}
            {part}
          </React.Fragment>
        ))}
      </StatusLine>
    </div>
  ) : null;

  // A paragraph that cannot be saved has to be visible from anywhere in the editor, not only while
  // it happens to be the selected one, because Save is what it will otherwise stop.
  const blockedNotice = blockedParagraphs.length > 0
    && !(blockedParagraphs.length === 1 && blockedParagraphs[0].block.id === activeBlockId) ? (
    <div role="status" className={compactViewport ? 'mx-auto mb-2 max-w-md' : 'mb-2'}>
      <StatusLine tone="caution">
        <span className="block">{t("edit-pdf.message.a37626224a", { v0: describeBlockedParagraphs(blockedParagraphs) })}</span>
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={reviewNextBlockedParagraph}
            className="chef-pressable chef-hit-y inline-flex h-9 items-center rounded-[var(--radius-control)] border border-[var(--border-strong)] px-2.5 text-xs font-bold text-[var(--text-primary)]"
          >
            {blockedParagraphs.length === 1
              ? t("edit-pdf.show.it.74484e")
              : t("edit-pdf.show.of.8e14d1", { v0: (blockedReviewIndex % blockedParagraphs.length) + 1, v1: blockedParagraphs.length })}
          </button>
          <button
            type="button"
            onClick={revertBlockedParagraphs}
            className="chef-pressable chef-hit-y inline-flex h-9 items-center rounded-[var(--radius-control)] px-2.5 text-xs font-bold text-[var(--status-danger-text)]"
          >{t('editor.revertBlocked', { count: blockedParagraphs.length })}</button>
        </span>
      </StatusLine>
    </div>
  ) : null;

  // A line that now runs past the paragraph's width is said in the inspector rather than in a
  // floating note, which used to sit on the very lines the reader was editing.
  const activeBlockPreview = activeBlock ? blockPreviews[activeBlock.id] : undefined;
  // Redrawn lines wrap to the paragraph's width, so only text kept on explicit rows (right-to-left
  // and Devanagari) can still run past it.
  const activeBlockOverflowsWidth = Boolean(activeBlockPreview && activeBlockPreview.text === activeBlockEdit?.text
    && (activeBlock?.direction === 'rtl' || activePlan?.reflow?.devanagari)
    && activeBlockPreview.pieces.some((piece) => piece.x + piece.width > activeBlockPreview.width + 0.5));

  const paragraphInspector = (compact: boolean) => (activeBlock ? (
    <PdfParagraphInspector
      key={activeBlock.id}
      block={activeBlock}
      edit={activeBlockEdit}
      descriptor={activeBlockDescriptor}
      font={activePlan?.font ?? (activeBlockDescriptor
        ? resolveFont(activeBlockDescriptor, activeBlockEdit?.text ?? activeBlock.text, activeBlockEdit?.fontOverride)
        : null)}
      plan={activePlan?.plan ?? null}
      overrun={activePlan?.reflow?.overrun ?? 0}
      overflowsWidth={activeBlockOverflowsWidth}
      ink={blockColorsRef.current[activeBlock.id]?.ink}
      compact={compact}
      field={compact && dockEditing ? (
        <PdfParagraphField
          block={activeBlock}
          edit={activeBlockEdit}
          inks={blockColorsRef.current[activeBlock.id]?.glyphs}
          bold={activeBlockEdit?.fontOverride?.bold ?? activeBlockDescriptor?.bold ?? false}
          italic={activeBlockEdit?.fontOverride?.italic ?? activeBlockDescriptor?.italic ?? false}
          focusRequest={fieldFocus}
          onBeginChange={handleBeginBlockChange}
          onChange={handleBlockChange}
        />
      ) : undefined}
      onUpdate={(updates) => updateBlockEdit(activeBlock.id, updates)}
      onRevert={() => revertBlock(activeBlock.id)}
      onDone={() => {
        (document.activeElement as HTMLElement | null)?.blur();
        setActiveBlockId(null);
      }}
    />
  ) : null);

  saveRef.current = handleSave;
  // Found on a phone: after a save the result's strip sat over the paragraph's B, I, size and Done.
  // Tapping Save already takes the caret, so once a file is out the button ends the edit and the
  // dock closes with it. A refused save keeps the paragraph, whose status line says why. Ctrl+S
  // leaves the caret where it is.
  const saveFromButton = async () => {
    if (!await handleSave()) return;
    if ((document.activeElement as HTMLElement | null)?.closest('[data-testid="pdf-text-block"]')) {
      (document.activeElement as HTMLElement).blur();
    }
    setActiveBlockId(null);
    setSelectedId(null);
  };

  if (isImmersiveEditor) {
    const selectedInspector = selectedElement ? (
      <PdfElementDock
        key={selectedElement.id}
        element={selectedElement}
        label={elementAction(selectedElement.type, 'properties')}
        more={<>
          {selectedElement.type !== 'line' && selectedElement.type !== 'arrow' && <label className="shrink-0 text-xs font-semibold text-[var(--text-secondary)]">{t("edit-pdf.rotate.c3613b")}<ClampedNumberInput key={selectedElement.id} min={-180} max={180} value={selectedElement.rotation || 0} onCommit={(rotation) => commitElementUpdate(selectedElement.id, { rotation })} className="mt-1 block h-10 w-16 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-2 text-sm text-[var(--text-primary)]" /></label>}
          <label className="shrink-0 text-xs font-semibold text-[var(--text-secondary)]">{t("edit-pdf.page.0a30a8")}<select value={selectedElement.pageIndex} onChange={(event) => { const nextPage = Number(event.target.value); commitElementUpdate(selectedElement.id, { pageIndex: nextPage }); goToPage(nextPage); }} className="mt-1 block h-10 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-2 text-sm text-[var(--text-primary)]">{Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>{formatNumber(index + 1)}</option>)}</select></label>
        </>}
        onChange={(updates) => commitElementUpdate(selectedElement.id, updates)}
        onDelete={() => deleteElement(selectedElement.id)}
        onDone={() => {
          (document.activeElement as HTMLElement | null)?.blur();
          setSelectedId(null);
        }}
      />
    ) : null;

    return (
      // Exactly one screen tall, with the PDF box taking whatever the header and bottom bar leave.
      // A box with a minimum height made the document taller than a window shrunk by the keyboard,
      // and the browser then scrolled the whole page to reveal the caret, sliding the paragraph
      // under the fixed header and the new text box under the bottom bar.
      // It draws its own screen, so it holds a tool screen's leave guards itself (s4-02).
      <ToolLeaveGuard holdsWork={hasUnsavedEdits}>
      {/* A sticky bar pins to the layout viewport, but iOS scrolls the *visual* viewport to
          reveal a focused paragraph — which slid this bar up under the status bar and clipped
          the Save button. Sitting on the measured offset, like the bottom bar does, keeps the
          title and Save against the top of what the reader can actually see. */}
      <div
        ref={immersiveHeaderRef}
        style={{ top: 'var(--chef-viewport-offset-top, 0px)' }}
        className="tk-edit-top chef-chrome chef-safe-x fixed inset-x-0 z-40 border-b border-[var(--border-hairline)]"
      >
        {/* The tool header (plan 2.23) in one row (A-018): Back when needed, Close editor, the name
            (its icon alone on a narrow phone), today's Find, Undo, Redo and Save, then Tools.
            The page gets the second row's height back; no control is removed. */}
        <ToolTop
          title={t("edit-pdf.edit.pdf.0e484d")}
          tool={routeTool}
          // Under 440 px the name is not drawn (only its heading is kept), so it is no link.
          nameLink={!narrowHeader}
          // Close editor stays at the start edge, where it is today (upgrade review M-3), so a
          // habit tap there still closes and the row ends with Save, then Tools.
          leading={(
            <button
              type="button"
              onClick={closeEditor}
              aria-label={t("edit-pdf.close.editor.bd0b7b")}
              className="tk-iconbtn chef-pressable"
            >
              <X aria-hidden size={21} />
            </button>
          )}
          trailing={(
            <div className="tk-edit-tools">
              <button type="button" onClick={toggleFind} aria-pressed={findOpen} aria-label={t("edit-pdf.find.and.replace.9898ad")} className={`chef-pressable chef-target grid shrink-0 place-items-center rounded-[var(--radius-control)] ${findOpen ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : 'text-[var(--text-secondary)]'}`}><Search aria-hidden size={19} /></button>
              <button type="button" onClick={undo} onPointerDown={holdEditingFocus} disabled={undoStack.current.length === 0} aria-label={t("edit-pdf.undo")} className="chef-pressable chef-target grid shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] disabled:opacity-55"><Undo2 aria-hidden size={19} /></button>
              <button type="button" onClick={redo} onPointerDown={holdEditingFocus} disabled={redoStack.current.length === 0} aria-label={t("edit-pdf.redo")} className="chef-pressable chef-target grid shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] disabled:opacity-55"><Redo2 aria-hidden size={19} /></button>
              <button type="button" data-main-action="" onClick={saveFromButton} disabled={status.isProcessing || !hasUnsavedEdits} aria-label={t("edit-pdf.save.1509f5")} className="tk-edit-save chef-pressable chef-target inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-3 text-sm font-bold text-[var(--text-on-accent)] disabled:opacity-55"><Save aria-hidden size={17} />{/* Spelled out wherever the row has room for it next to Tools' word
                  (tool.css, Edit PDF levels): a lone disk glyph is exactly the icon a reader who did
                  not grow up with it has to guess at. */}<span>{t("edit-pdf.save.1509f5")}</span></button>
            </div>
          )}
        />
      </div>
      <main
        className="flex h-[100dvh] flex-col bg-[var(--surface-canvas)]"
        style={{
          paddingTop: `calc(${immersiveHeaderHeight}px + var(--chef-viewport-offset-top, 0px))`,
          paddingBottom: `calc(${immersiveBottomBarHeight}px + var(--chef-keyboard-inset, 0px))`,
        }}
      >

        <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col px-2 py-2 sm:px-4">
          {(status.error || (status.message && !(saveKind === 'complete' && status.progress === 100))) && (
            <div aria-live="polite" role={status.error ? 'alert' : 'status'} className={`mb-2 ${status.error || status.isProcessing ? '' : 'chef-hide-while-typing'}`}>
              <StatusLine tone={status.error ? 'danger' : status.progress === 100 ? (saveKind === 'partial' ? 'caution' : 'success') : 'info'}>
                {status.error || status.message}
              </StatusLine>
            </div>
          )}

          {/* One row on a phone: the page box, not the chrome, gets the height. It wraps only where
              a narrow screen or large text leaves no other way. While the keyboard is up it goes
              too: pinching still zooms, and the row is back as soon as the keyboard closes. */}
          <div className="chef-hide-while-typing mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-3">
            {pageCount > 1 && (
              <div className="flex min-w-0 items-center gap-0.5 rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-0.5">
                <button type="button" onClick={() => goToPage(targetPageIndex - 1)} disabled={targetPageIndex === 0} aria-label={t("edit-pdf.previous.page.1208ec")} className="chef-pressable chef-hit-y grid h-9 w-touch shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] disabled:opacity-55"><ChevronLeft aria-hidden size={19} className="rtl:rotate-180" /></button>
                <label className="flex h-9 min-w-0 items-center text-xs font-semibold text-[var(--text-primary)]">
                  <span className="sr-only">{t("edit-pdf.page.0a30a8")}</span>
                  {/* The select keeps the 48px touch floor but overhangs the 36px pill, so the page
                      pill and the zoom pill stay the same height. */}
                  <select value={targetPageIndex} onChange={(event) => goToPage(Number(event.target.value))} aria-label={t("edit-pdf.current.editor.page.7fc923")} className="-my-1.5 min-w-0 max-w-full bg-transparent tabular outline-none">
                    {/* "12 / 61", not "12 of 61": the shorter label keeps the zoom controls on the same row. */}
                    {Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>{`${formatNumber(index + 1)} / ${formatNumber(pageCount)}`}</option>)}
                  </select>
                </label>
                <button type="button" onClick={() => goToPage(targetPageIndex + 1)} disabled={targetPageIndex >= pageCount - 1} aria-label={t("edit-pdf.next.page.c08ac7")} className="chef-pressable chef-hit-y grid h-9 w-touch shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] disabled:opacity-55"><ChevronRight aria-hidden size={19} className="rtl:rotate-180" /></button>
              </div>
            )}
            <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} max={EDITOR_MAX_ZOOM} compact keepFocus className="ms-auto" />
          </div>

          <div className="flex max-h-[48rem] min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-panel)] bg-[var(--surface-sunken)]">
            <div
              ref={bindPdfZoomViewport}
              onPointerDownCapture={handlePdfPointerDown}
              data-testid="pdf-zoom-viewport"
              data-pdf-zoom={zoom.toFixed(3)}
              className={`chef-pdf-zoom-viewport min-h-0 flex-1 overflow-x-auto overflow-y-auto p-2 sm:p-8 ${insertMode ? 'cursor-crosshair' : ''}`}
            >
              <PDFPage
                key={targetPageIndex}
                pageIndex={targetPageIndex}
                pageCount={pageCount}
                pdfDoc={pdfDoc}
                elements={elements.filter((element) => element.pageIndex === targetPageIndex)}
                formFields={formFields.filter((field) => field.pageIndex === targetPageIndex)}
                formValues={formValues}
                selectedId={selectedId}
                onSelect={selectElement}
                onUpdate={updateElement}
                onBeginElementChange={rememberSnapshot}
                onDelete={deleteElement}
                onFormValueChange={updateFormValue}
                onPagePress={handlePagePress}
                blockEdits={blockEdits}
                blockPreviews={blockPreviews}
                activeBlockId={activeBlockId}
                coarsePointer={coarsePointer}
                cachedText={readCachedPageText}
                onBlocksReady={handleBlocksReady}
                onActivateBlock={handlePageActivate}
                onBlockChange={handleBlockChange}
                onBeginBlockChange={handleBeginBlockChange}
                insertMode={insertMode}
                placementLabel={elementAction(insertMode === 'text' ? 'text' : shapeKind, 'choose')}
                zoom={zoom}
              />
            </div>
          </div>
        </div>

        {/* A fixed bar resolves against the layout viewport, which on a phone is taller than the
            part of the page you can actually see once the keyboard is up or the browser has
            rescaled the page around a focused paragraph. Sitting on the measured inset keeps the
            paragraph controls and Save reachable in both cases instead of below the fold. */}
        <div
          ref={immersiveBottomBarRef}
          style={{ bottom: 'var(--chef-keyboard-inset, 0px)' }}
          className={`tk-edit-bottom chef-chrome chef-safe-bottom chef-keyboard-flush chef-safe-x fixed inset-x-0 z-40 border-t border-[var(--border-hairline)] px-2 pb-2 pt-2${activeBlock ? ' chef-paragraph-bar' : ''}`}
        >
          <ResultSlot className="tk-edit-result" />
          {findBar}
          {scannedNotice}
          {blockedNotice}
          {paragraphInspector(true)}
          {selectedInspector}
          {/* Shape asks which shape only once it is chosen, instead of keeping a picker on screen. */}
          {insertMode === 'shape' && (
            <div role="radiogroup" aria-label={t("edit-pdf.shape.type.78d36b")} className="mx-auto mb-1 grid max-w-md grid-cols-4 gap-1">
              {([
                ['rectangle', Square, t("edit-pdf.rectangle.030699")],
                ['ellipse', Circle, t("edit-pdf.ellipse.cb1ee8")],
                ['line', Minus, t("edit-pdf.line.d7852c")],
                ['arrow', ArrowRight, t("edit-pdf.arrow.05800e")],
              ] as const).map(([kind, Icon, label]) => (
                <button key={kind} type="button" role="radio" aria-checked={shapeKind === kind} aria-label={label} onClick={() => setShapeKind(kind)} className={`chef-pressable chef-target flex items-center justify-center rounded-[var(--radius-control)] ${shapeKind === kind ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : 'text-[var(--text-secondary)]'}`}><Icon aria-hidden size={19} /></button>
              ))}
            </div>
          )}
          {insertMode && (
            <div aria-live="polite" className="mx-auto mb-1 max-w-md text-center text-xs font-semibold text-[var(--accent-text)]">{elementAction(insertMode === 'text' ? 'text' : shapeKind, 'choose')}</div>
          )}
          {/* Text, Image and Shape give their row to the page while the keyboard is up, and to a
              paragraph's or an added item's own controls while one is chosen. Done brings them back. */}
          {!activeBlock && !selectedElement && <div role="toolbar" aria-label={t("edit-pdf.add.content.006e1f")} className="chef-hide-while-typing mx-auto grid max-w-md grid-cols-3 gap-1">
            <button
              type="button"
              aria-pressed={insertMode === 'text'}
              onClick={(event) => {
                if (event.detail === 0) addText();
                else toggleInsertMode('text');
              }}
              className={`chef-pressable chef-target flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-[var(--radius-control)] text-xs font-bold ${insertMode === 'text' ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : 'text-[var(--text-secondary)]'}`}
            ><Type aria-hidden size={19} /><span>{t("edit-pdf.text.71988c")}</span></button>
            <button type="button" onClick={() => { setInsertMode(null); imageInputRef.current?.click(); }} className="chef-pressable chef-target flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-[var(--radius-control)] text-xs font-bold text-[var(--text-secondary)]"><ImagePlus aria-hidden size={19} /><span>{t("edit-pdf.image.1aa4cb")}</span></button>
            <button
              type="button"
              aria-pressed={insertMode === 'shape'}
              onClick={(event) => {
                if (event.detail === 0) addShape();
                else toggleInsertMode('shape');
              }}
              className={`chef-pressable chef-target flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-[var(--radius-control)] text-xs font-bold ${insertMode === 'shape' ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : 'text-[var(--text-secondary)]'}`}
            ><Shapes aria-hidden size={19} /><span>{t("edit-pdf.shape.e0e492")}</span></button>
          </div>}
          <input ref={imageInputRef} type="file" accept=".png,.jpg,.jpeg,image/png,image/jpeg" className="hidden" onChange={(event) => { void addImage(event.target.files?.[0]); event.currentTarget.value = ''; }} />
        </div>
        {discardSheet}
        {announcer}
      </main>
      </ToolLeaveGuard>
    );
  }

  if (!file) {
    return (
      <ToolScreen
        title={t("edit-pdf.edit.pdf.e089a9")}
        kind="file"
        body={(
          <div className="tk-empty">
            {/* A file that would not open leaves no document, so its reason is said in the zone (T-09). */}
            <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label={t("edit-pdf.choose.a.pdf.to.edit.8d2720")} error={status.error} />
          </div>
        )}
        extra={discardSheet}
      />
    );
  }

  const desktopEditor = (
    <div className="tk-edit-desk mx-auto w-full max-w-6xl px-4 py-4">
       <div ref={deskControlsRef} className="mb-3 flex flex-col gap-2">
          {/* This is a beta editor and the export is what gets shared: the caution is Save's
              description and tooltip (T-14), not a line under the header. */}
          <span id="edit-desk-review" className="sr-only">{t("edit-pdf.review.the.result.before.sharing.83dca8")}</span>
          {file && (
             <div role="toolbar" aria-label={t("edit-pdf.pdf.editor.tools.f127be")} className="flex flex-wrap items-center gap-2 rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-2">
                <button type="button" onClick={() => goToPage(targetPageIndex - 1)} disabled={targetPageIndex === 0} aria-label={t("edit-pdf.previous.page.1208ec")} className="chef-hit-y chef-pressable flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--border-strong)] text-[var(--text-secondary)] disabled:opacity-55"><ChevronLeft size={20} className="rtl:rotate-180" /></button>
                <label className="flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 text-sm font-semibold text-[var(--text-primary)]">{t("edit-pdf.page.0a30a8")}<select value={targetPageIndex} onChange={(event) => goToPage(Number(event.target.value))} aria-label={t("edit-pdf.current.editor.page.7fc923")} className="min-h-11 bg-transparent outline-none">
                    {Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>{t("edit-pdf.message.ef59ff32b8", { v0: index + 1, v1: pageCount })}</option>)}
                  </select>
                </label>
                <button type="button" onClick={() => goToPage(targetPageIndex + 1)} disabled={targetPageIndex >= pageCount - 1} aria-label={t("edit-pdf.next.page.c08ac7")} className="chef-hit-y chef-pressable flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--border-strong)] text-[var(--text-secondary)] disabled:opacity-55"><ChevronRight size={20} className="rtl:rotate-180" /></button>
                <span className="mx-1 hidden h-7 w-px bg-[var(--border-hairline)] sm:block" aria-hidden="true" />
                <button type="button" onClick={undo} disabled={undoStack.current.length === 0} aria-label={t("edit-pdf.undo")} className="chef-hit-y chef-pressable flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text-secondary)] disabled:opacity-55"><Undo2 size={18} /></button>
                <button type="button" onClick={redo} disabled={redoStack.current.length === 0} aria-label={t("edit-pdf.redo")} className="chef-hit-y chef-pressable flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text-secondary)] disabled:opacity-55"><Redo2 size={18} /></button>
                <button type="button" onClick={toggleFind} aria-pressed={findOpen} className={`chef-hit-y chef-pressable flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border px-4 font-bold ${findOpen ? 'border-[var(--accent-rest)] bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : 'border-[var(--border-strong)] text-[var(--text-primary)] hover:border-[var(--accent-rest)]'}`}><Search size={18}/>{t("edit-pdf.find.0684d7")}</button>
                <button type="button" aria-pressed={insertMode === 'text'} onClick={(event) => { if (event.detail === 0) addText(); else toggleInsertMode('text'); }} className={`chef-hit-y chef-pressable flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border px-4 font-bold ${insertMode === 'text' ? 'border-[var(--accent-rest)] bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : 'border-[var(--border-strong)] text-[var(--text-primary)] hover:border-[var(--accent-rest)]'}`}><Type size={18}/>{t("edit-pdf.text.d0bd6e")}</button>
                <button type="button" onClick={() => { setInsertMode(null); imageInputRef.current?.click(); }} className="chef-hit-y chef-pressable flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-4 font-bold text-[var(--text-primary)] hover:border-[var(--accent-rest)]"><ImagePlus size={18}/>{t("edit-pdf.image.246731")}</button>
                <input ref={imageInputRef} type="file" accept=".png,.jpg,.jpeg,image/png,image/jpeg" className="hidden" onChange={(event) => { void addImage(event.target.files?.[0]); event.currentTarget.value = ''; }} />
                <div className="flex min-h-11 flex-wrap overflow-hidden rounded-[var(--radius-control)] border border-[var(--border-strong)]">
                  <select value={shapeKind} onChange={(event) => setShapeKind(event.target.value as EditorElement['type'])} aria-label={t("edit-pdf.shape.type.78d36b")} className="min-h-11 border-0 bg-[var(--surface-raised)] px-2 text-sm font-semibold text-[var(--text-primary)] outline-none">
                    <option value="rectangle">{t("edit-pdf.rectangle.030699")}</option><option value="ellipse">{t("edit-pdf.ellipse.cb1ee8")}</option><option value="line">{t("edit-pdf.line.d7852c")}</option><option value="arrow">{t("edit-pdf.arrow.05800e")}</option>
                  </select>
                  <button type="button" onClick={() => addShape()} aria-label={elementAction(shapeKind, 'add')} className="chef-hit-y chef-pressable flex min-h-11 items-center gap-1 border-l border-[var(--border-strong)] px-3 font-bold text-[var(--text-primary)]"><Shapes size={18}/>{t("edit-pdf.add.0d40dd")}</button>
                </div>
                <button type="button" data-main-action="" onClick={saveFromButton} disabled={status.isProcessing || !hasUnsavedEdits} aria-describedby="edit-desk-review" title={t("edit-pdf.review.the.result.before.sharing.83dca8")} className="chef-hit-y chef-pressable flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-6 font-bold text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)] disabled:opacity-55"><Save size={18}/>{t("edit-pdf.save.52453d")}</button>
                <ResultSlot className="tk-editor-result" />
             </div>
          )}
          {insertMode && (
            <p role="status" className="px-2 py-1 text-sm font-semibold text-[var(--accent-text)]">{elementAction(insertMode === 'text' ? 'text' : shapeKind, 'choose')}</p>
          )}
          {findBar}
          {scannedNotice}
          {blockedNotice}
          {selectedElement && (
            <div role="region" aria-label={elementAction(selectedElement.type, 'properties')} className="rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] px-3 py-2">
              <div className="flex flex-wrap items-end gap-2">
                <span className="pb-2.5 text-xs font-semibold uppercase tracking-[0.15em] text-[var(--text-secondary)]">{elementAction(selectedElement.type, 'selected')}</span>
                {selectedElement.type === 'text' && <label className="min-w-0 flex-1 basis-[220px] text-xs font-semibold text-[var(--text-secondary)]">{t("edit-pdf.text.71988c")}<input value={selectedElement.content} onChange={(event) => updateInspectorText(selectedElement.id, event.currentTarget.value)} onBlur={finishInspectorTextChange} className="mt-1 h-11 w-full rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-rest)] focus:shadow-[inset_0_0_0_1px_var(--accent-rest)]" /></label>}
                {selectedElement.type !== 'image' && <label className="text-xs font-semibold text-[var(--text-secondary)]">{t("edit-pdf.colour.3a9dfa")}<input type="color" value={selectedElement.color || '#2563eb'} onChange={(event) => commitElementUpdate(selectedElement.id, { color: event.target.value })} className="mt-1 block h-11 w-12 rounded border border-[var(--border-strong)] bg-transparent p-1" /></label>}
                {selectedElement.type === 'text' && <label className="text-xs font-semibold text-[var(--text-secondary)]">{t("edit-pdf.font.64d0b3")}<select value={selectedElement.fontFamily || 'Helvetica'} onChange={(event) => commitElementUpdate(selectedElement.id, { fontFamily: event.target.value })} className="mt-1 block h-11 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-2 text-sm text-[var(--text-primary)]"><option value="Helvetica">{t("edit-pdf.helvetica.447688")}</option><option value="TimesRoman">{t("edit-pdf.times.0c0fd3")}</option><option value="Courier">{t("edit-pdf.courier.bbc5df")}</option></select></label>}
                {selectedElement.type === 'text' && <label className="text-xs font-semibold text-[var(--text-secondary)]">{t("edit-pdf.size.1af851")}<ClampedNumberInput key={selectedElement.id} min={8} max={72} value={selectedElement.fontSize || 16} onCommit={(fontSize) => commitElementUpdate(selectedElement.id, { fontSize })} className="mt-1 block h-11 w-20 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-2 text-sm text-[var(--text-primary)]" /></label>}
                {(selectedElement.type === 'rectangle' || selectedElement.type === 'ellipse') && <label className="flex min-h-11 items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]"><input type="checkbox" checked={Boolean(selectedElement.fillColor && selectedElement.fillColor !== 'transparent')} onChange={(event) => commitElementUpdate(selectedElement.id, { fillColor: event.target.checked ? '#93c5fd' : 'transparent' })} className="h-5 w-5" />{t("edit-pdf.fill.c9fa1d")}</label>}
                {(selectedElement.type === 'rectangle' || selectedElement.type === 'ellipse') && selectedElement.fillColor !== 'transparent' && <label className="text-xs font-semibold text-[var(--text-secondary)]">{t("edit-pdf.fill.colour.1c2981")}<input type="color" value={selectedElement.fillColor || '#93c5fd'} onChange={(event) => commitElementUpdate(selectedElement.id, { fillColor: event.target.value })} className="mt-1 block h-11 w-12 rounded border border-[var(--border-strong)] bg-transparent p-1" /></label>}
                {selectedElement.type !== 'text' && selectedElement.type !== 'image' && <label className="text-xs font-semibold text-[var(--text-secondary)]">{t("edit-pdf.stroke.1582a1")}<ClampedNumberInput key={selectedElement.id} min={1} max={16} value={selectedElement.strokeWidth || 2} onCommit={(strokeWidth) => commitElementUpdate(selectedElement.id, { strokeWidth })} className="mt-1 block h-11 w-20 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-2 text-sm text-[var(--text-primary)]" /></label>}
                {selectedElement.type !== 'line' && selectedElement.type !== 'arrow' && <label className="text-xs font-semibold text-[var(--text-secondary)]">{t("edit-pdf.rotate.c3613b")}<ClampedNumberInput key={selectedElement.id} min={-180} max={180} value={selectedElement.rotation || 0} onCommit={(rotation) => commitElementUpdate(selectedElement.id, { rotation })} className="mt-1 block h-11 w-20 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-2 text-sm text-[var(--text-primary)]" /></label>}
                  <label className="text-xs font-semibold text-[var(--text-secondary)]">{t("edit-pdf.page.0a30a8")}<select value={selectedElement.pageIndex} onChange={(event) => { const nextPage = Number(event.target.value); commitElementUpdate(selectedElement.id, { pageIndex: nextPage }); goToPage(nextPage); }} className="mt-1 block h-11 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-2 text-sm text-[var(--text-primary)]">{Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>{formatNumber(index + 1)}</option>)}</select></label>
                <button type="button" onClick={() => deleteElement(selectedElement.id)} className="chef-hit-y chef-pressable inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-control)] border border-[var(--status-danger-text)] px-3 text-sm font-bold text-[var(--status-danger-text)] hover:bg-[var(--status-danger-quiet)]"><Trash2 size={16}/>{t("edit-pdf.delete.3534d6")}</button>
              </div>
            </div>
          )}
          {file && (status.message || status.error) && (
            <div aria-live="polite" role={status.error ? 'alert' : 'status'}>
              <StatusLine tone={status.error ? 'danger' : status.progress === 100 ? (saveKind === 'partial' ? 'caution' : 'success') : 'info'}>
                {status.error || status.message}
              </StatusLine>
            </div>
          )}
       </div>

       {(
             <div className="relative overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)]">
                <div ref={deskBandRef} className="flex items-start gap-2 border-b border-[var(--border-hairline)] bg-[var(--surface-raised)] px-2 py-1.5">
                  {paragraphInspector(false)}
                  <div className="ms-auto shrink-0 [&_button]:h-11 [&_button]:w-11 [&_button]:p-0">
                    <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} max={EDITOR_MAX_ZOOM} keepFocus />
                  </div>
                </div>
                <div
                  ref={bindPdfZoomViewport}
                  onPointerDownCapture={handlePdfPointerDown}
                  data-testid="pdf-zoom-viewport"
                  data-pdf-zoom={zoom.toFixed(3)}
                  className="chef-pdf-zoom-viewport h-[70dvh] min-h-96 max-h-[48rem] overflow-x-auto overflow-y-auto p-2 sm:p-8"
                >
                      <PDFPage
                          key={targetPageIndex} pageIndex={targetPageIndex} pageCount={pageCount} pdfDoc={pdfDoc}
                          elements={elements.filter(e => e.pageIndex === targetPageIndex)}
                          formFields={formFields.filter((field) => field.pageIndex === targetPageIndex)}
                          formValues={formValues}
                          selectedId={selectedId} onSelect={selectElement}
                          onUpdate={updateElement} onBeginElementChange={rememberSnapshot} onDelete={deleteElement}
                          onFormValueChange={updateFormValue}
                          onPagePress={handlePagePress}
                          blockEdits={blockEdits}
                          blockPreviews={blockPreviews}
                          activeBlockId={activeBlockId}
                          coarsePointer={coarsePointer}
                          cachedText={readCachedPageText}
                          onBlocksReady={handleBlocksReady}
                          onActivateBlock={handlePageActivate}
                          onBlockChange={handleBlockChange}
                          onBeginBlockChange={handleBeginBlockChange}
                          insertMode={insertMode}
                          placementLabel={elementAction(insertMode === 'text' ? 'text' : shapeKind, 'choose')}
                          zoom={zoom}
                      />
                </div>
             </div>
          )}
    </div>
  );

  return (
    <ToolScreen
      title={t("edit-pdf.edit.pdf.e089a9")}
      kind="editor"
      holdsWork={hasUnsavedEdits}
      file={{ name: file.name }}
      body={desktopEditor}
      extra={<>{discardSheet}{announcer}</>}
    />
  );
};
