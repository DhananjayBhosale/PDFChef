
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import {
  getPageTextBackgroundPatch,
  getPdfFormFields,
  loadEditablePDFDocument,
  type PdfFormFieldDefinition,
  type PdfFormFieldValue,
} from '../../services/pdfBrowser';
import {
  savePDFWithAnnotations,
  PDF_EDIT_PERMISSION_MESSAGE,
  type EditorElement,
  type ParagraphFace,
  type ParagraphSaveEdit,
} from '../../services/pdfDocument';
import { getPageTextBlocks, resolvePageFonts, type PageTextBlocks } from '../../services/pdfBlockExtraction';
import type { PdfTextBlock } from '../../services/pdfTextBlocks';
import {
  blockStyledSegments,
  findInStyledLines,
  planBlockEdit,
  replaceInStyledLines,
  styledLineText,
  wrapStyledText,
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
  paintFindHighlights,
  scrollBlockIntoViewport,
  selectRangeInBlock,
  useKeyboardSafeFocus,
  type BlockColors,
  type BlockEditState,
} from './PdfTextBlockLayer';
import { PdfFindReplace } from './PdfFindReplace';
import { PdfParagraphInspector } from './PdfParagraphInspector';
import { deliverBlob } from '../../services/pdfShared';
import { normalizeImageFile } from '../../services/imageBrowser';
import { ChevronLeft, ChevronRight, ImagePlus, Redo2, Save, Search, Shapes, Trash2, Type, Undo2, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Badge, StatusLine } from '../UI/Primitives';
import { v4 as uuidv4 } from 'uuid';
import { Link, useBlocker } from 'react-router-dom';
import { ZoomControls } from '../UI/ZoomControls';
import { useZoom } from '../../hooks/useZoom';
import { usePdfPinchZoom } from '../../hooks/usePdfPinchZoom';
import { useImmersiveWorkspace } from '../Layout/AppShell';
import { PDF_TEXT_OVERFLOW_MESSAGE } from '../../services/pdfTextEditSafety';
import { pdfPageFromScrollBoundary } from '../../services/pdfZoomGesture';
import { releaseNativePdfTextDocument } from '../../services/pdfNativeTextEditor';

const DISCARD_EDITS_MESSAGE = 'Discard your unsaved edits?';
const editorCssFontFamily = (fontFamily: string | undefined) => (
  fontFamily === 'TimesRoman'
    ? 'Times New Roman'
    : fontFamily === 'Courier'
      ? 'Courier New'
      : 'Arial'
);

const normalizeInspectorFontSize = (element: EditorElement, rawValue: string) => {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return element.fontSize || 16;
  return Math.max(8, Math.min(72, parsed));
};

interface EditorSnapshot {
  elements: EditorElement[];
  blockEdits: Record<string, BlockEditState>;
}

const serializeEditorState = (
  elements: EditorElement[],
  formValues: Record<string, PdfFormFieldValue>,
  blockEdits: Record<string, BlockEditState> = {},
) => JSON.stringify({
  elements,
  formValues,
  // Only the typed result matters for the dirty check; the cached repaint image does not.
  blocks: Object.values(blockEdits).map(({ blockId, text, fontOverride, color, fontSize }) => ({
    blockId,
    text,
    fontOverride,
    color,
    fontSize,
  })),
});

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
const EDITOR_MAX_ZOOM = 4;
/** PDF permission flag for "modify contents", as PDF.js reports it. */
const PDF_PERMISSION_MODIFY_CONTENTS = 8;
/** How long after the last keystroke the paragraph's save plan is worked out. */
const PLAN_SETTLE_MS = 180;

/**
 * Say which paragraphs could not be written, and why, in the reader's terms.
 *
 * Reasons repeat — one unavailable glyph usually blocks the same handful of paragraphs — so they
 * are grouped, and the pages are named because on a long document that is the only way to find
 * them again.
 */
const describeBlockedParagraphs = (
  blocked: Array<{ block: { pageIndex: number }; plan: { mode: string; reason?: string } }>,
) => {
  const byReason = new Map<string, number[]>();
  blocked.forEach(({ block, plan }) => {
    const reason = plan.reason ?? 'it cannot be written back to this PDF';
    byReason.set(reason, [...(byReason.get(reason) ?? []), block.pageIndex + 1]);
  });

  const listPages = (pages: number[]) => {
    const unique = [...new Set(pages)].sort((first, second) => first - second);
    if (unique.length === 1) return `page ${unique[0]}`;
    if (unique.length <= 4) return `pages ${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
    return `${unique.length} pages, starting at page ${unique[0]}`;
  };

  const parts = [...byReason.entries()]
    .slice(0, 2)
    .map(([reason, pages]) => `on ${listPages(pages)}, ${reason}`);
  const rest = byReason.size - parts.length;

  return `${blocked.length === 1 ? 'One paragraph was' : `${blocked.length.toLocaleString()} paragraphs were`} left as the document wrote them: ${parts.join('; ')}${rest > 0 ? `; and ${rest} other reason${rest === 1 ? '' : 's'}` : ''}.`;
};

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
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
  ));

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => setCompact(media.matches);
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
  activeBlockId: string | null;
  coarsePointer: boolean;
  cachedText?: (pageIndex: number) => PageTextBlocks | undefined;
  onBlocksReady: (pageIndex: number, blocks: PageTextBlocks, colors: Record<string, BlockColors>) => void;
  onActivateBlock: (blockId: string | null) => void;
  onBlockChange: (blockId: string, text: string) => void;
  onBeginBlockChange: (blockId: string) => void;
  insertMode: 'text' | 'shape' | null;
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
  activeBlockId,
  coarsePointer,
  cachedText,
  onBlocksReady,
  onActivateBlock,
  onBlockChange,
  onBeginBlockChange,
  insertMode,
  zoom,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isRendered, setIsRendered] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(600);
  const [textBlocks, setTextBlocks] = useState<PdfTextBlock[]>([]);
  const [blockFonts, setBlockFonts] = useState<PageTextBlocks['fonts']>(() => new Map());
  // Base dimensions at scale 1.0 (PDF Points)
  const [dims, setDims] = useState({ w: 600, h: 850 });

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
        // Render at a high fixed scale (e.g. 2.0) for sharpness when zooming in
        // We do NOT re-render on zoom change, we just scale the CSS
        const renderScale = 2.0; 
        const viewport = page.getViewport({ scale: renderScale });
        
        // Store logical dimensions (1.0 scale) for layout
        setDims({ w: viewport.width / renderScale, h: viewport.height / renderScale });
        
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
          onBlocksReady(pageIndex, pageText, samplePageBlockColors(canvas, pageText.blocks, renderScale));
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
      role="group"
      className="relative mx-auto shrink-0 bg-white shadow-lg"
      style={{ width: scaledW, height: scaledH }} // Helper wrapper for layout flow
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        onPagePress({
          x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
          y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
        });
      }}
      aria-label={`Page ${pageIndex + 1} of ${pageCount}`}
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
            isSelected={selectedId === el.id}
            onSelect={() => onSelect(el.id)}
            onUpdate={onUpdate} onDelete={onDelete} onBeginChange={onBeginElementChange}
          />
        ))}
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
        className="absolute flex items-center justify-center rounded border border-paper-500 bg-white/85 shadow-sm"
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
        className="absolute flex items-center justify-center rounded border border-paper-500 bg-white/85 shadow-sm"
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
        className={`absolute rounded border border-paper-500 bg-white/92 text-paper-900 shadow-sm outline-none focus:border-[var(--accent-rest)] focus:ring-2 focus:ring-[var(--focus-ring)] ${hit.className}`}
      >
        {field.kind === 'select' && <option value="">Select...</option>}
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
        className={`absolute rounded border border-paper-500 bg-white/92 text-paper-900 shadow-sm outline-none focus:border-[var(--accent-rest)] focus:ring-2 focus:ring-[var(--focus-ring)] ${hit.className}`}
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
      className={`absolute rounded border border-paper-500 bg-white/92 text-paper-900 shadow-sm outline-none focus:border-[var(--accent-rest)] focus:ring-2 focus:ring-[var(--focus-ring)] ${hit.className}`}
    />
  );
};

// Re-implementing simplified ResizableElement
const ResizableElement: React.FC<any> = ({ element, isSelected, onSelect, onUpdate, onDelete, onBeginChange, containerRef, displayScale }) => {
  const [editMode, setEditMode] = useState<'drag' | 'resize' | null>(null);
  const origin = useRef({ clientX: 0, clientY: 0, x: 0, y: 0, width: 0.2, height: 0.1 });
  const gestureChanged = useRef(false);
  const inlineTextEditorRef = useRef<HTMLTextAreaElement>(null);
  const inlineTextChanged = useRef(false);
  const wasSelected = useRef(false);
  const width = element.width || (element.type === 'text' ? 0.24 : 0.22);
  const height = element.height || (element.type === 'text' ? 0.07 : 0.14);
  const cssFontFamily = editorCssFontFamily(element.fontFamily);
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

  useEffect(() => {
    if (element.type !== 'text') return;
    if (isSelected && !wasSelected.current) {
      const inlineTextEditor = inlineTextEditorRef.current;
      if (inlineTextEditor) {
        inlineTextEditor.focus({ preventScroll: true });
        inlineTextEditor.setSelectionRange(0, inlineTextEditor.value.length);
      }
    }
    if (!isSelected) inlineTextChanged.current = false;
    wasSelected.current = isSelected;
  }, [element.type, isSelected]);

  const handleStart = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    onSelect();
    gestureChanged.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = { clientX: event.clientX, clientY: event.clientY, x: element.x, y: element.y, width, height };
    setEditMode('drag');
  };

  const handleResizeStart = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onSelect();
    gestureChanged.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = { clientX: event.clientX, clientY: event.clientY, x: element.x, y: element.y, width, height };
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
    const clampedWidth = clamp(nextWidth, 0.04, 1 - element.x);
    const clampedHeight = clamp(nextHeight, 0.025, 1 - element.y);
    if (clampedWidth === width && clampedHeight === height) return;
    if (!event.repeat) onBeginChange();
    onUpdate(element.id, {
      width: clampedWidth,
      height: clampedHeight,
    });
  };

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      if (!editMode || !containerRef.current) return;
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
        const nextWidth = clamp(origin.current.width + dx, 0.04, 1 - origin.current.x);
        const nextHeight = clamp(origin.current.height + dy, 0.025, 1 - origin.current.y);
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

    const handleEnd = () => {
      gestureChanged.current = false;
      setEditMode(null);
    };
    if (editMode) {
       window.addEventListener('pointermove', handleMove);
       window.addEventListener('pointerup', handleEnd);
       window.addEventListener('pointercancel', handleEnd);
    }
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleEnd);
      window.removeEventListener('pointercancel', handleEnd);
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
      aria-label={`${isSelected ? 'Selected ' : ''}${element.type} on page ${element.pageIndex + 1}. Press Enter to select${isSelected ? element.type === 'text' ? ', edit in the text field, use arrow keys to move, or Delete to remove' : ', use arrow keys to move, or Delete to remove' : ''}.`}
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
           aria-label={`Edit text on page ${element.pageIndex + 1}`}
           value={element.content}
           placeholder="Text"
           rows={1}
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
           className="h-full w-full touch-auto resize-none overflow-hidden border-0 bg-transparent px-1.5 py-1 outline-none"
           style={{
             fontSize: `${element.fontSize}px`,
             color: element.color,
             fontFamily: cssFontFamily,
             fontWeight: element.fontWeight,
             fontStyle: element.fontStyle,
             lineHeight: 1.2,
             whiteSpace: 'pre-wrap',
           }}
         />
        </>
      ) : element.type === 'text' ? (
         <div
           className="h-full w-full overflow-hidden px-1.5 py-1"
           style={{
             fontSize: `${element.fontSize}px`,
             color: element.color,
             fontFamily: cssFontFamily,
             fontWeight: element.fontWeight,
             fontStyle: element.fontStyle,
             lineHeight: 1.2,
             whiteSpace: 'pre-wrap',
           }}
         >
           {element.content || 'Text'}
         </div>
      ) : (
         element.type === 'image'
           ? <img src={element.content} alt="Added PDF graphic" className="h-full w-full object-contain pointer-events-none" />
           : shapePreview
      )}
      {isSelected && (
        <button
          type="button"
          aria-label="Resize selected element with arrow keys"
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
  const [file, setFile] = useState<PDFFile | null>(null);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [elements, setElements] = useState<EditorElement[]>([]);
  const elementsRef = useRef<EditorElement[]>([]);
  const documentGeneration = useRef(0);
  const replaceElements = useCallback((next: EditorElement[]) => {
    elementsRef.current = next;
    setElements(next);
  }, []);
  const [formFields, setFormFields] = useState<PdfFormFieldDefinition[]>([]);
  const [formValues, setFormValues] = useState<Record<string, PdfFormFieldValue>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [blockEdits, setBlockEdits] = useState<Record<string, BlockEditState>>({});
  const blockEditsRef = useRef<Record<string, BlockEditState>>({});
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const pageTextRef = useRef<Map<number, PageTextBlocks>>(new Map());
  const blockColorsRef = useRef<Record<string, BlockColors>>({});
  const blockIndexRef = useRef<Map<string, PdfTextBlock>>(new Map());
  const [blocksVersion, setBlocksVersion] = useState(0);
  const [pagesWithoutText, setPagesWithoutText] = useState<number[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findReplacement, setFindReplacement] = useState('');
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
  const [, setHistoryVersion] = useState(0);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pdfZoomViewportRef = useRef<HTMLDivElement | null>(null);
  const immersiveBottomBarRef = useRef<HTMLDivElement>(null);
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
    if (activeFile) void releaseNativePdfTextDocument(activeFile);
  }, []);
  const setPdfZoomViewport = usePdfPinchZoom({ zoom, setZoom: setExactZoom, max: EDITOR_MAX_ZOOM });
  const bindPdfZoomViewport = useCallback((viewport: HTMLDivElement | null) => {
    pdfZoomViewportRef.current = viewport;
    setPdfZoomViewport(viewport);
  }, [setPdfZoomViewport]);
  const selectedElement = elements.find((element) => element.id === selectedId) ?? null;
  const fillableFieldCount = useMemo(
    () => new Set(formFields.map((field) => field.fieldName)).size,
    [formFields],
  );
  const pageCount = pdfDoc?.numPages || 0;
  const compactViewport = useCompactEditorViewport();
  const coarsePointer = useCoarsePointer();

  useKeyboardSafeFocus(pdfZoomViewportRef.current, activeBlockId);

  /**
   * Bring a paragraph up to a size that can actually be edited by thumb before handing it the
   * caret. Mobile browsers zoom the entire page when focus lands on text under about 16px, which
   * throws away the scroll position and the user's place in the document; raising the editor's own
   * zoom instead keeps the page where it is and makes the text legible while typing.
   */
  const handleActivateBlock = useCallback((blockId: string | null) => {
    setActiveBlockId(blockId);
    if (blockId) setSelectedId(null);
    if (!blockId || !coarsePointer) return;
    const element = document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`);
    if (!element) return;
    // The page is drawn inside a CSS transform, so the computed font size is the unscaled one.
    // What the browser and the reader actually see is that size times the transform's scale.
    const layoutHeight = element.offsetHeight;
    const scale = layoutHeight > 0 ? element.getBoundingClientRect().height / layoutHeight : 1;
    const renderedFontSize = Number.parseFloat(window.getComputedStyle(element).fontSize) * scale;
    if (!Number.isFinite(renderedFontSize) || renderedFontSize <= 0) return;
    if (renderedFontSize >= MINIMUM_EDITING_FONT_PX) return;
    setExactZoom(Math.min(EDITOR_MAX_ZOOM, zoom * (MINIMUM_EDITING_FONT_PX / renderedFontSize)));
  }, [coarsePointer, setExactZoom, zoom]);
  const isNativeAndroidEditor = Boolean(file) && Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  const isCompactViewportEditor = Boolean(file) && compactViewport;
  const isImmersiveEditor = isNativeAndroidEditor || isCompactViewportEditor;
  const currentSnapshot = useMemo(
    () => serializeEditorState(elements, formValues, blockEdits),
    [blockEdits, elements, formValues],
  );
  const hasUnsavedEdits = Boolean(file) && currentSnapshot !== savedSnapshot;
  const navigationBlocker = useBlocker(hasUnsavedEdits);

  useImmersiveWorkspace(isImmersiveEditor);

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

  const goToPage = useCallback((nextPageIndex: number) => {
    if (pageCount <= 0) return;
    setTargetPageIndex(Math.max(0, Math.min(pageCount - 1, nextPageIndex)));
    setSelectedId(null);
    setInsertMode(null);
  }, [pageCount]);

  useEffect(() => {
    const viewport = pdfZoomViewportRef.current;
    if (!viewport || pageCount < 2) return undefined;
    let changingPage = false;
    let releaseTimer: number | undefined;

    const handlePageBoundaryWheel = (event: WheelEvent) => {
      if (event.ctrlKey || changingPage) return;
      const nextPage = pdfPageFromScrollBoundary({
        currentPage: targetPageIndex,
        pageCount,
        zoom,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        atStart: viewport.scrollTop <= 2,
        atEnd: viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2,
      });
      if (nextPage === targetPageIndex) return;

      event.preventDefault();
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

    viewport.addEventListener('wheel', handlePageBoundaryWheel, { passive: false });
    return () => {
      viewport.removeEventListener('wheel', handlePageBoundaryWheel);
      if (releaseTimer !== undefined) window.clearTimeout(releaseTimer);
    };
  }, [goToPage, isImmersiveEditor, pageCount, targetPageIndex, zoom]);

  const handleFilesSelected = async (files: File[]) => {
    if (files.length === 0) return;
    const nextFile = files[0];
    const generation = ++documentGeneration.current;
    replacingSourceIds.current.clear();
    if (file?.file) void releaseNativePdfTextDocument(file.file);
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
    setInsertMode(null);
    undoStack.current = [];
    redoStack.current = [];
    setHistoryVersion((value) => value + 1);
    setFile(null);
    setStatus({ isProcessing: true, progress: 10, message: 'Opening this PDF locally…' });
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
          message: 'This PDF allows reading but not changes, so an edited version cannot be written. Remove the password with the Unlock PDF tool first, then edit the result.',
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
          ? 'This PDF is password protected, so its text cannot be read for editing. Remove the password with the Unlock PDF tool first, then open the result here.'
          : damaged
            ? 'This file could not be read as a PDF. It may be damaged or incomplete; the Repair PDF tool can sometimes recover one.'
            : reason || 'Unable to open this PDF.',
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
  });

  const restoreSnapshot = (snapshot: EditorSnapshot) => {
    replaceElements(snapshot.elements);
    replaceBlockEdits(snapshot.blockEdits);
  };

  const rememberSnapshot = () => {
    undoStack.current = [...undoStack.current.slice(-79), captureSnapshot()];
    redoStack.current = [];
    setHistoryVersion((value) => value + 1);
  };

  const commitElements = (updater: (current: EditorElement[]) => EditorElement[]) => {
    const next = updater(elementsRef.current);
    if (next === elementsRef.current) return;
    undoStack.current = [...undoStack.current.slice(-79), captureSnapshot()];
    redoStack.current = [];
    replaceElements(next);
    setHistoryVersion((value) => value + 1);
  };

  const undo = () => {
    const previous = undoStack.current.at(-1);
    if (!previous) return;
    redoStack.current = [...redoStack.current, captureSnapshot()];
    undoStack.current = undoStack.current.slice(0, -1);
    restoreSnapshot(previous);
    setSelectedId(null);
    setHistoryVersion((value) => value + 1);
  };

  const redo = () => {
    const next = redoStack.current.at(-1);
    if (!next) return;
    undoStack.current = [...undoStack.current, captureSnapshot()];
    redoStack.current = redoStack.current.slice(0, -1);
    restoreSnapshot(next);
    setSelectedId(null);
    setHistoryVersion((value) => value + 1);
  };

  const addText = (x = 0.1, y = 0.1) => {
    const newEl: EditorElement = {
      id: uuidv4(), type: 'text', pageIndex: targetPageIndex,
      x: Math.min(0.72, Math.max(0, x)),
      y: Math.min(0.93, Math.max(0, y)),
      width: 0.28, height: 0.07, content: 'Text', fontSize: 16, color: '#000000', fontFamily: 'Helvetica'
    };
    commitElements((current) => [...current, newEl]);
    setSelectedId(newEl.id);
    setInsertMode(null);
  };

  const addShape = (x = 0.12, y = 0.14) => {
    const newEl: EditorElement = {
      id: uuidv4(),
      type: shapeKind,
      pageIndex: targetPageIndex,
      x: Math.min(0.76, Math.max(0, x)),
      y: Math.min(0.84, Math.max(0, y)),
      width: 0.24,
      height: shapeKind === 'line' || shapeKind === 'arrow' ? 0.12 : 0.16,
      content: '',
      color: '#2563eb',
      fillColor: 'transparent',
      strokeWidth: 2,
    };
    commitElements((current) => [...current, newEl]);
    setSelectedId(newEl.id);
    setInsertMode(null);
  };

  const handlePagePress = ({ x, y }: { x: number; y: number }) => {
    if (insertMode === 'text') {
      addText(x - 0.03, y - 0.025);
      return;
    }
    if (insertMode === 'shape') {
      addShape(x - 0.04, y - 0.04);
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
    // A paragraph on a single colour needs no picture of its background: the preview fills it with
    // the colour sampled off the page, and the save writes the same colour as a vector rectangle.
    // Skipping the render keeps the common case free, and keeps it off the page PDF.js has already
    // drawn for the screen.
    if (blockColorsRef.current[block.id]?.flat) return;
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
      replaceBlockEdits({ ...blockEditsRef.current, [block.id]: { ...existing, patch } });
    } catch {
      // Pages whose drawing operations cannot be matched safely keep the sampled paper colour.
      // That is a flat fill rather than a reconstruction, so the paragraph stays honest about it.
    }
  }, [pdfDoc, replaceBlockEdits]);

  const handleBeginBlockChange = useCallback((_blockId: string) => {
    rememberSnapshot();
  }, []);

  const handleBlockChange = useCallback((blockId: string, text: string, segments: StyledSegment[][]) => {
    const block = blockIndexRef.current.get(blockId);
    if (!block) return;
    const existing = blockEditsRef.current[blockId];
    const colors = blockColorsRef.current[blockId];
    const isNew = !existing;
    const next: BlockEditState = {
      blockId,
      pageIndex: block.pageIndex,
      text,
      segments,
      fontOverride: existing?.fontOverride,
      color: existing?.color ?? colors?.ink,
      fontSize: existing?.fontSize,
      patch: existing?.patch,
      patchColor: existing?.patchColor ?? colors?.paper ?? '#ffffff',
      patchFlat: existing?.patchFlat ?? colors?.flat ?? false,
      sampledColors: existing?.sampledColors ?? Boolean(colors),
      reflowing: existing?.reflowing ?? false,
    };
    replaceBlockEdits({ ...blockEditsRef.current, [blockId]: next });

  }, [replaceBlockEdits, requestBlockPatch]);

  /** The paragraph's text as styled segments: what it was edited to, or what the PDF drew. */
  const blockSegments = useCallback((block: PdfTextBlock, edit: BlockEditState | undefined) => (
    edit?.segments ?? blockStyledSegments(block)
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

  const revealMatch = useCallback((index: number) => {
    const match = findMatches[index];
    if (!match) return;
    if (match.pageIndex !== targetPageIndex) setTargetPageIndex(match.pageIndex);
    // The page may still be rendering, so try again on the next frames rather than once.
    let attempts = 0;
    const place = () => {
      const element = document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(match.blockId)}"]`);
      const length = match.match.end - match.match.start;
      if (element && selectRangeInBlock(element, match.offset, match.offset + length)) {
        setActiveBlockId(match.blockId);
        const viewport = pdfZoomViewportRef.current;
        if (viewport) scrollBlockIntoViewport(viewport, element);
        return;
      }
      if (attempts < 40) {
        attempts += 1;
        window.requestAnimationFrame(place);
      }
    };
    window.requestAnimationFrame(place);
  }, [findMatches, targetPageIndex]);

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
        return range ? [range] : [];
      });
      paintFindHighlights(ranges);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [blockEdits, blocksVersion, findMatches, findOpen, findQuery, targetPageIndex]);

  useEffect(() => clearFindHighlights, []);

  const stepMatch = useCallback((delta: number) => {
    if (findMatches.length === 0) return;
    const next = (findIndex + delta + findMatches.length) % findMatches.length;
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
    setStatus({
      isProcessing: false,
      progress: 0,
      message: `Replaced ${total.toLocaleString()} ${total === 1 ? 'match' : 'matches'} across ${updates.length.toLocaleString()} ${updates.length === 1 ? 'paragraph' : 'paragraphs'}. Review them before saving.`,
    });
  }, [blockSegments, commitBlockSegments, findCaseSensitive, findMatches, findQuery, findReplacement]);

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
    rememberSnapshot();
    const colors = blockColorsRef.current[blockId];
    const base: BlockEditState = existing ?? {
      blockId,
      pageIndex: block.pageIndex,
      text: block.text,
      color: colors?.ink,
      patchColor: colors?.paper ?? '#ffffff',
      patchFlat: colors?.flat ?? false,
      sampledColors: Boolean(colors),
      reflowing: false,
    };
    replaceBlockEdits({ ...blockEditsRef.current, [blockId]: { ...base, ...updates } });
  }, [replaceBlockEdits, requestBlockPatch]);

  const addImage = async (selectedFile: File | undefined) => {
    if (!selectedFile) return;
    const generation = documentGeneration.current;
    if (!['image/png', 'image/jpeg'].includes(selectedFile.type)) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Choose a PNG or JPEG image.' });
      return;
    }
    try {
      // Decode and re-encode first. Besides normalising EXIF orientation, this prevents unusual
      // but valid compressed PNG streams from tying up pdf-lib's pure-JavaScript decoder.
      const normalizedFile = await normalizeImageFile(selectedFile);
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => reject(new Error('Unable to read this image.'));
        reader.readAsDataURL(normalizedFile);
      });
      if (generation !== documentGeneration.current) return;
      if (!content) throw new Error('Unable to read this image.');
      const newEl: EditorElement = {
        id: uuidv4(), type: 'image', pageIndex: targetPageIndex,
        x: 0.1, y: 0.1, width: 0.28, height: 0.2, content,
      };
      commitElements((current) => [...current, newEl]);
      setSelectedId(newEl.id);
    } catch (error) {
      if (generation !== documentGeneration.current) return;
      setStatus({ isProcessing: false, progress: 0, message: '', error: error instanceof Error ? error.message : 'Unable to read this image.' });
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
  };
  const updateFormValue = (fieldName: string, value: PdfFormFieldValue) =>
    setFormValues((prev) => ({ ...prev, [fieldName]: value }));

  const confirmDiscardEdits = useCallback(
    () => !hasUnsavedEdits || window.confirm(DISCARD_EDITS_MESSAGE),
    [hasUnsavedEdits],
  );

  const closeEditor = useCallback(() => {
    if (!confirmDiscardEdits()) return;

    if (file?.file) void releaseNativePdfTextDocument(file.file);
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
    setInsertMode(null);
    undoStack.current = [];
    redoStack.current = [];
    setHistoryVersion((value) => value + 1);
    setStatus({ isProcessing: false, progress: 0, message: '' });
  }, [confirmDiscardEdits, file, replaceBlockEdits, replaceElements]);

  // The editor's history is one stack over paragraphs, annotations and shapes, so the keyboard
  // shortcut has to drive that rather than whatever a focused paragraph's own undo would do.
  // Capture phase, because the editable stops the event from reaching the document.
  const historyKeysRef = useRef({ undo: () => {}, redo: () => {} });
  historyKeysRef.current = { undo, redo };
  const saveRef = useRef<() => Promise<void> | void>(() => {});

  useEffect(() => {
    if (!file) return undefined;
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      const redoing = key === 'y' || (key === 'z' && event.shiftKey);
      if (key !== 'z' && !redoing) return;
      const target = event.target as HTMLElement | null;
      // Text fields of our own — find, replace, the inspector — keep their own undo.
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
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
    if (!hasUnsavedEdits) return undefined;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedEdits]);

  useEffect(() => {
    if (navigationBlocker.state !== 'blocked') return;
    if (confirmDiscardEdits()) navigationBlocker.proceed();
    else navigationBlocker.reset();
  }, [confirmDiscardEdits, navigationBlocker]);

  useEffect(() => {
    if (!isImmersiveEditor) return undefined;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeEditor();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [closeEditor, isImmersiveEditor]);

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
    const timer = window.setTimeout(() => setSettledBlockEdits(blockEdits), PLAN_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [blockEdits]);

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
        || (edit.color !== undefined && edit.color !== blockColorsRef.current[edit.blockId]?.ink);
      const rotated = Math.abs(block.angle) > 0.02;
      const planned: BlockEditPlan = restyled
        // Restyling changes every glyph on the line, which no in-place text rewrite can express.
        ? rotated
          ? { mode: 'blocked', reason: 'rotated or skewed text cannot be restyled, because redrawing it would not follow its baseline' }
          : { mode: 'reflow', reason: 'the paragraph’s typeface, size or colour was changed' }
        : planBlockEdit(block, edit.text, {
          measure: (text: string, fontSize: number, fontKey: string) =>
            measureTextWidth(text, runFont(fontKey).resolved, fontSize),
          maxU: pageText?.pageWidth,
        });

      const original = new Set(block.text);
      const introduced = [...new Set(edit.text)].filter((character) => !original.has(character)).join('');
      /**
       * Whether the PDF's own font can draw what the edit introduces.
       *
       * Rewriting a text object in place keeps the document's font, and most PDFs embed only the
       * glyphs they already used — a heading set in a display face may carry no "b" and no "0" at
       * all. The PDF engine does not refuse when one is missing: it writes the character code
       * anyway, and the file then reads back correctly through the very engines that wrote it while
       * rendering as an empty box in Preview, Acrobat and print. Nothing downstream catches that,
       * so the font is asked here, and a paragraph it cannot draw is redrawn with one that can.
       */
      const missingFromOwnFont = planned.mode === 'direct' && descriptor && introduced
        ? checkGlyphCoverage(descriptor, introduced)
        : null;
      const plan: BlockEditPlan = missingFromOwnFont?.checked && !missingFromOwnFont.covered
        ? {
          mode: 'reflow',
          reason: `this PDF's own font has no ${describeCharacters(missingFromOwnFont.missing)} in it`,
        }
        : planned;
      // A redraw writes each stretch in its own face, so a character only counts as unwritable when
      // the face that will actually draw it has no glyph for it.
      const unencodable = plan.mode === 'reflow'
        ? ([...new Set(block.lines.flatMap((line) => line.runs.flatMap((run) => {
          const face = runFont(run.fontKey);
          return unencodableCharacters(run.text, face.resolved, face.descriptor);
        })))] as string[]).slice(0, 6)
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
              ? `no font available here can draw ${describeCharacters(typed)}`
              : `this paragraph contains ${describeCharacters(unencodable)}, which only the PDF's own font can draw — so it can be shortened or replaced in place, but not made longer`,
          },
          font,
          descriptor,
          reflow: null,
        };
      }

      if (plan.mode !== 'reflow') return { edit, block, plan, font, descriptor, reflow: null };
      const resolvedPlan: BlockEditPlan = plan;

      const resolved = font ?? FALLBACK_RESOLVED_FONT;
      const fontSize = edit.fontSize ?? block.fontSize;
      const lineHeight = Math.max(fontSize, block.leading * (fontSize / block.fontSize));
      // A restyled paragraph is deliberately one face throughout; otherwise each stretch keeps the
      // face it was drawn in, so a bold lead-in survives the redraw.
      const faceFor = (fontKey: string) => (restyled || !fontKey
        ? { descriptor, resolved }
        : runFont(fontKey));
      const segments = edit.segments ?? [block.text.split('\n').map((line) => ({ text: line, fontKey: block.fontKey }))];
      const lines = wrapStyledText(
        segments,
        (text, fontKey) => measureTextWidth(text, faceFor(fontKey).resolved, fontSize),
        block.measure,
      );
      const height = Math.max(block.height, lines.length * lineHeight + fontSize * 0.3);
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
        font,
        descriptor,
        reflow: { resolved, faceFor, fontSize, lineHeight, lines, height, overrun: Math.max(0, height - available) },
      };
    }).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .filter((entry) => entry.plan.mode !== 'unchanged');
  }, []);

  /**
   * Fetch a paragraph's background only when something will actually draw it.
   *
   * A patch is a full page render, and only a redraw ever uses one — a rewrite in place never
   * touches the background at all. Firing one per edited paragraph the moment the text changed
   * meant a whole-document replace put a thousand page renders on the main thread. Driven from the
   * settled plan instead, and one at a time, so the page it is prepared for stays usable.
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
    [blocksVersion, buildParagraphPlans, settledBlockEdits],
  );

  const activePlan = activeBlockId
    ? paragraphPlans.find((entry) => entry.edit.blockId === activeBlockId) ?? null
    : null;

  useEffect(() => {
    paragraphPlans.forEach(({ edit, block, plan }) => {
      if (plan.mode !== 'reflow') return;
      if (edit.patch || edit.patchFlat) return;
      // Unknown means the page was never drawn, so its colours were never sampled. A flat fill in
      // the paper colour is the honest answer there, not a page render nobody asked for.
      if (!edit.sampledColors) return;
      enqueueBlockPatch(block);
    });
  }, [enqueueBlockPatch, paragraphPlans]);

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
    { forceReflow = false, deleteOriginalRuns = true, plans = paragraphPlans } = {},
  ): ParagraphSaveEdit[] => (
    plans.flatMap(({ edit, block, plan, descriptor, reflow }) => {
      // A paragraph the file cannot express is left exactly as the document wrote it. Refusing the
      // whole save instead would throw away every other edit — and on a long document that is
      // thousands of them, discarded because of one character on one page.
      if (plan.mode === 'blocked') return [];
      if (plan.mode === 'direct' && !forceReflow) {
        return [{ mode: 'direct' as const, pageIndex: block.pageIndex, runEdits: plan.runEdits }];
      }

      const pageText = pageTextRef.current.get(block.pageIndex);
      const pageWidth = pageText?.pageWidth ?? block.left + block.measure;
      const pageHeight = pageText?.pageHeight ?? block.top + block.height;
      const resolved = reflow?.resolved ?? FALLBACK_RESOLVED_FONT;
      const fontSize = reflow?.fontSize ?? edit.fontSize ?? block.fontSize;
      const lineHeight = reflow?.lineHeight ?? Math.max(fontSize, block.leading);
      const faceFor = reflow?.faceFor ?? (() => ({ descriptor, resolved }));
      const wrapped = reflow?.lines ?? wrapStyledText(
        edit.segments ?? [edit.text.split('\n').map((line) => ({ text: line, fontKey: block.fontKey }))],
        (text, fontKey) => measureTextWidth(text, faceFor(fontKey).resolved, fontSize),
        block.measure,
      );
      const toFace = (fontKey: string): ParagraphFace => {
        const face = faceFor(fontKey);
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
          bold: face.descriptor?.bold ?? face.resolved.cssWeight === '700',
          italic: face.descriptor?.italic ?? face.resolved.cssStyle === 'italic',
        };
      };
      const lines = wrapped.map((line) => line.map((segment) => ({ text: segment.text, face: toFace(segment.fontKey) })));
      const height = reflow?.height ?? Math.max(block.height, lines.length * lineHeight + fontSize * 0.3);

      return [{
        mode: 'reflow' as const,
        pageIndex: block.pageIndex,
        x: block.left / pageWidth,
        y: block.top / pageHeight,
        width: Math.max(block.width, block.measure) / pageWidth,
        height: height / pageHeight,
        // Every source run in the paragraph is removed before the redraw, so the file never keeps
        // words that are no longer on the page.
        runDeletions: deleteOriginalRuns
          ? block.lines.flatMap((line) => line.runs.flatMap((run) => (
            // A run that draws only spacing leaves no ink to remove, and matching a whitespace-only
            // text object against the PDF engine is unreliable enough to fail the whole deletion.
            run.sourcePdfRect && run.sourceText?.trim()
              ? [{ sourceText: run.sourceText, sourcePdfRect: run.sourcePdfRect }]
              : []
          )))
          : [],
        backgroundImage: edit.patch,
        backgroundColor: edit.patchColor ?? '#ffffff',
        backgroundFlat: deleteOriginalRuns && (edit.patchFlat ?? false),
        lines,
        fontSize,
        lineHeight,
        align: block.align,
        color: edit.color ?? '#000000',
      }];
    })
  ), [paragraphPlans]);

  const handleSave = async () => {
    if (!file) return;
    const generation = documentGeneration.current;
    setStatus({ isProcessing: true, progress: 20, message: 'Saving PDF edits locally…' });
    try {
      let bytes: Uint8Array;
      /** Set when even the redraw could not remove the originals, so the old words remain. */
      let redrawReason = '';
      /** Set when the in-place rewrite was planned but did not hold, and paragraphs were redrawn. */
      let fallbackReason = '';
      // Planned from the live edits rather than the settled ones: a save can arrive inside the
      // window where the last keystroke has not been planned yet.
      if (patchQueueRef.current.length > 0 || patchDrainingRef.current) {
        setStatus({ isProcessing: true, progress: 15, message: 'Preparing paragraph backgrounds…' });
        while (patchQueueRef.current.length > 0 || patchDrainingRef.current) {
          await new Promise((resolve) => window.setTimeout(resolve, 60));
          if (generation !== documentGeneration.current) return;
        }
      }
      let plans = buildParagraphPlans(blockEditsRef.current);

      // A paragraph that is about to be redrawn, or about to be refused, is one whose answer
      // depends on the document's own fonts — and those are unread on any page the reader never
      // opened, which is every page a replace-all touched. Read them, then decide again.
      const pagesNeedingFonts = [...new Set(plans
        .filter((entry) => entry.plan.mode === 'reflow' || entry.plan.mode === 'blocked')
        .map((entry) => entry.block.pageIndex as number))]
        .filter((pageIndex) => [...(pageTextRef.current.get(pageIndex)?.fonts.values() ?? [])]
          .some((descriptor) => descriptor.resolution === 'pending'));

      if (pagesNeedingFonts.length > 0 && pdfDoc) {
        setStatus({
          isProcessing: true,
          progress: 30,
          message: `Reading the fonts on ${pagesNeedingFonts.length} ${pagesNeedingFonts.length === 1 ? 'page' : 'pages'}…`,
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
          plans = buildParagraphPlans(blockEditsRef.current);
        }
      }
      const blockedPlans = plans.filter((entry) => entry.plan.mode === 'blocked');
      const savablePlans = plans.filter((entry) => entry.plan.mode !== 'blocked');
      // Narrowed if the rewrite has to fall back to redrawing, which not every paragraph can do.
      const redrawable = new Set(savablePlans);
      if (savablePlans.length === 0 && blockedPlans.length > 0) {
        throw new Error(`This edit cannot be saved: ${describeBlockedParagraphs(blockedPlans)}`);
      }
      try {
        bytes = await savePDFWithAnnotations(file.file, elements, formValues, buildParagraphSaveEdits({ plans: savablePlans }));
      } catch (directEditError) {
        // Rewriting a PDF's own text objects needs PDF.js and the PDF engine to agree on what the
        // text says, and ligatures and custom encodings sometimes make them disagree. That only
        // surfaces here, so rather than losing the edit, redraw the affected paragraphs over the
        // original words instead of through them — and say that is what happened.
        if (!(directEditError instanceof Error) || !directEditError.message.startsWith('Direct text edit failed:')) {
          throw directEditError;
        }
        if (savablePlans.length === 0) throw directEditError;
        // The paragraph inspector said these would be rewritten in place. They were not, and a
        // redraw is a visibly different thing to have done to someone's document, so the reason
        // is kept and reported rather than letting the save look like the promised one.
        fallbackReason = directEditError.message.replace(/^Direct text edit failed:\s*/, '');
        // eslint-disable-next-line no-console
        console.warn('Paragraph redrawn instead of edited in place:', fallbackReason);
        // Rewriting in place failed, so every remaining paragraph has to be redrawn — and a redraw
        // can only write what its face has glyphs for. Those are set aside and reported alongside
        // the ones the planner already knew about, rather than failing the batch.
        savablePlans.forEach((entry) => {
          const characters = unencodableCharacters(
            entry.edit.text,
            entry.font ?? FALLBACK_RESOLVED_FONT,
            entry.descriptor,
          );
          if (characters.length === 0) return;
          redrawable.delete(entry);
          blockedPlans.push({
            ...entry,
            plan: {
              mode: 'blocked',
              reason: `it contains ${describeCharacters(characters)}, which only this PDF's own font can draw`,
            },
          });
        });
        if (redrawable.size === 0) {
          throw new Error(`This edit cannot be saved: ${describeBlockedParagraphs(blockedPlans)}`);
        }
        setStatus({ isProcessing: true, progress: 60, message: 'Redrawing the edited paragraphs instead…' });
        try {
          // Removing the originals first is what keeps the file honest, and it usually still works
          // even when rewriting them in place did not.
          bytes = await savePDFWithAnnotations(
            file.file,
            elements,
            formValues,
            buildParagraphSaveEdits({ forceReflow: true, plans: [...redrawable] }),
          );
        } catch (deletionError) {
          if (!(deletionError instanceof Error) || !deletionError.message.startsWith('Direct text edit failed:')) {
            throw deletionError;
          }
          redrawReason = deletionError.message.replace(/^Direct text edit failed:\s*/, '');
          // eslint-disable-next-line no-console
          console.warn('Original text could not be removed before redrawing:', redrawReason);
          bytes = await savePDFWithAnnotations(
            file.file,
            elements,
            formValues,
            buildParagraphSaveEdits({ forceReflow: true, deleteOriginalRuns: false, plans: [...redrawable] }),
          );
        }
      }
      if (generation !== documentGeneration.current) return;
      await deliverBlob(new Blob([bytes], { type: 'application/pdf' }), `edited-${file.name}`);
      if (generation !== documentGeneration.current) return;
      // Anything that was not written stays dirty, so the leave-guard still protects it and the
      // notice still points at it. Marking the whole document clean would quietly discard it.
      const skipped = new Set(blockedPlans.map((entry) => entry.edit.blockId));
      const savedBlockEdits = Object.fromEntries(
        (Object.entries(blockEditsRef.current) as Array<[string, BlockEditState]>)
          .filter(([blockId]) => !skipped.has(blockId)),
      );
      setSavedSnapshot(serializeEditorState(elementsRef.current, formValues, savedBlockEdits));
      setStatus({
        isProcessing: false,
        progress: 100,
        message: blockedPlans.length > 0
          ? `Edited PDF ready, with ${(plans.length - blockedPlans.length).toLocaleString()} of ${plans.length.toLocaleString()} edited paragraphs written. ${describeBlockedParagraphs(blockedPlans)} Your edits to ${blockedPlans.length === 1 ? 'it' : 'them'} are still here.`
          : redrawReason
          // The internal reason is left out of both of these. It names the part of the PDF that
          // would not cooperate, which tells the reader nothing they can act on; what they need is
          // what it means for the file in their hands. The reason is logged for support instead.
          ? `Edited PDF ready — but your old wording is still in the file underneath the new text, where a search could find it. Check it before sharing anything private.`
          : fallbackReason
          ? `Edited PDF ready. The paragraphs you changed were redrawn, so their lettering may sit a little differently from the rest of the page. Your old wording has been removed. Have a look before you share it.`
          : 'Edited PDF ready. Review it before sharing.',
      });
    } catch (error) {
      if (generation !== documentGeneration.current) return;
      if (error instanceof Error && error.name === 'AbortError') {
        setStatus({ isProcessing: false, progress: 0, message: 'Save cancelled. Your edits are still here.' });
        return;
      }
      const message = error instanceof Error ? error.message : '';
      // A refusal we chose to make is an answer, not a fault, so it does not go to the console.
      if (!message.startsWith('This edit cannot be saved') && message !== PDF_EDIT_PERMISSION_MESSAGE) {
        console.error(error);
      }
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: message === PDF_TEXT_OVERFLOW_MESSAGE
          || message === PDF_EDIT_PERMISSION_MESSAGE
          || message.startsWith('This edit cannot be saved')
          || message.startsWith('Visual fallback is unavailable')
          ? message
          : message.startsWith('Direct text edit failed:')
          ? `${message} Your edits are still here.`
          : 'Unable to save the edited PDF. Your edits are still here so you can try again.',
      });
    }
  };

  const activeBlock = activeBlockId ? blockIndexRef.current.get(activeBlockId) ?? null : null;
  const activeBlockDescriptor = activeBlock
    ? pageTextRef.current.get(activeBlock.pageIndex)?.fonts.get(activeBlock.fontKey)
    : undefined;
  const activeBlockEdit = activeBlockId ? blockEdits[activeBlockId] : undefined;
  const findBar = findOpen ? (
    <PdfFindReplace
      query={findQuery}
      replacement={findReplacement}
      caseSensitive={findCaseSensitive}
      matchCount={findMatches.length}
      activeMatch={findIndex}
      scanning={findScanning}
      showReplace={findShowReplace}
      compact={compactViewport}
      onQueryChange={(value) => { setFindQuery(value); setFindIndex(0); }}
      onReplacementChange={setFindReplacement}
      onCaseSensitiveChange={setFindCaseSensitive}
      onShowReplaceChange={setFindShowReplace}
      onStep={stepMatch}
      onReplaceOne={replaceCurrentMatch}
      onReplaceAll={replaceAllMatches}
      onClose={() => { setFindOpen(false); setFindQuery(''); }}
    />
  ) : null;

  // A page whose text is part of a scan has nothing to edit and no reason why, which reads as the
  // editor being broken. Say what the page is and point at the tool that fixes it.
  const scannedNotice = pagesWithoutText.includes(targetPageIndex) ? (
    <div role="status" className={compactViewport ? 'mx-auto mb-2 max-w-md' : 'mb-2'}>
      <StatusLine tone="caution">
        Page {targetPageIndex + 1} has no text layer, so its words are part of a picture and cannot
        be edited here. Run <Link to="/ocr" className="font-bold underline">OCR</Link> on this PDF
        first to add a text layer, then reopen it here. You can still add text, shapes and images
        to this page.
      </StatusLine>
    </div>
  ) : null;

  // A paragraph that cannot be saved has to be visible from anywhere in the editor, not only while
  // it happens to be the selected one, because Save is what it will otherwise stop.
  const blockedNotice = blockedParagraphs.length > 0 ? (
    <div role="status" className={compactViewport ? 'mx-auto mb-2 max-w-md' : 'mb-2'}>
      <StatusLine tone="caution">
        <span className="block">
          {describeBlockedParagraphs(blockedParagraphs)} Saving now writes the{' '}
          {(paragraphPlans.length - blockedParagraphs.length).toLocaleString()} other edited
          {paragraphPlans.length - blockedParagraphs.length === 1 ? ' paragraph' : ' paragraphs'} and
          leaves {blockedParagraphs.length === 1 ? 'this one' : 'these'} untouched.
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={reviewNextBlockedParagraph}
            className="chef-pressable chef-hit-y inline-flex h-9 items-center rounded-[var(--radius-control)] border border-[var(--border-strong)] px-2.5 text-xs font-bold text-[var(--text-primary)]"
          >
            {blockedParagraphs.length === 1
              ? 'Show it'
              : `Show ${(blockedReviewIndex % blockedParagraphs.length) + 1} of ${blockedParagraphs.length}`}
          </button>
          <button
            type="button"
            onClick={revertBlockedParagraphs}
            className="chef-pressable chef-hit-y inline-flex h-9 items-center rounded-[var(--radius-control)] px-2.5 text-xs font-bold text-[var(--status-danger-text)]"
          >
            Revert {blockedParagraphs.length === 1 ? 'it' : `these ${blockedParagraphs.length}`}
          </button>
        </span>
      </StatusLine>
    </div>
  ) : null;

  const paragraphInspector = (compact: boolean) => (activeBlock ? (
    <PdfParagraphInspector
      block={activeBlock}
      edit={activeBlockEdit}
      descriptor={activeBlockDescriptor}
      font={activePlan?.font ?? (activeBlockDescriptor
        ? resolveFont(activeBlockDescriptor, activeBlockEdit?.text ?? activeBlock.text, activeBlockEdit?.fontOverride)
        : null)}
      plan={activePlan?.plan ?? null}
      overrun={activePlan?.reflow?.overrun ?? 0}
      compact={compact}
      onUpdate={(updates) => updateBlockEdit(activeBlock.id, updates)}
      onRevert={() => revertBlock(activeBlock.id)}
      onDone={() => {
        (document.activeElement as HTMLElement | null)?.blur();
        setActiveBlockId(null);
      }}
    />
  ) : null);

  saveRef.current = handleSave;

  if (isImmersiveEditor) {
    const selectedTypeLabel = selectedElement
      ? selectedElement.type.charAt(0).toUpperCase() + selectedElement.type.slice(1)
      : '';
    const selectedInspector = selectedElement ? (
      <section aria-label={`Selected ${selectedElement.type} properties`} className="mx-auto mb-2 max-w-md rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-2 shadow-lg">
        <div className="custom-scrollbar flex items-end gap-2 overflow-x-auto pb-1">
          <div className="shrink-0 text-xs font-semibold text-[var(--text-secondary)]">
            <span className="block uppercase tracking-[0.12em]">{selectedTypeLabel}</span>
            <button type="button" onClick={() => deleteElement(selectedElement.id)} className="chef-pressable chef-target mt-1 inline-flex h-10 items-center gap-1 rounded-[var(--radius-control)] px-2 text-xs font-bold text-[var(--status-danger-text)]"><Trash2 aria-hidden size={15} /> Delete</button>
          </div>
          {selectedElement.type === 'text' && <label className="w-44 shrink-0 text-xs font-semibold text-[var(--text-secondary)]">Text<input value={selectedElement.content} onChange={(event) => updateInspectorText(selectedElement.id, event.currentTarget.value)} onBlur={finishInspectorTextChange} className="mt-1 h-10 w-full rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-rest)]" /></label>}
          {selectedElement.type !== 'image' && <label className="shrink-0 text-xs font-semibold text-[var(--text-secondary)]">Colour<input type="color" value={selectedElement.color || '#2563eb'} onChange={(event) => commitElementUpdate(selectedElement.id, { color: event.target.value })} className="mt-1 block h-10 w-12 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-transparent p-1" /></label>}
          {selectedElement.type === 'text' && <label className="shrink-0 text-xs font-semibold text-[var(--text-secondary)]">Font<select value={selectedElement.fontFamily || 'Helvetica'} onChange={(event) => commitElementUpdate(selectedElement.id, { fontFamily: event.target.value })} className="mt-1 block h-10 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-2 text-sm text-[var(--text-primary)]"><option value="Helvetica">Helvetica</option><option value="TimesRoman">Times</option><option value="Courier">Courier</option></select></label>}
          {selectedElement.type === 'text' && <label className="shrink-0 text-xs font-semibold text-[var(--text-secondary)]">Size<input type="number" min={8} max={72} value={selectedElement.fontSize || 16} onChange={(event) => commitElementUpdate(selectedElement.id, { fontSize: normalizeInspectorFontSize(selectedElement, event.target.value) })} className="mt-1 block h-10 w-16 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-2 text-sm text-[var(--text-primary)]" /></label>}
          {(selectedElement.type === 'rectangle' || selectedElement.type === 'ellipse') && <label className="flex h-10 shrink-0 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-2 text-xs font-semibold text-[var(--text-secondary)]"><input type="checkbox" checked={Boolean(selectedElement.fillColor && selectedElement.fillColor !== 'transparent')} onChange={(event) => commitElementUpdate(selectedElement.id, { fillColor: event.target.checked ? '#93c5fd' : 'transparent' })} className="h-5 w-5" /> Fill</label>}
          {(selectedElement.type === 'rectangle' || selectedElement.type === 'ellipse') && selectedElement.fillColor !== 'transparent' && <label className="shrink-0 text-xs font-semibold text-[var(--text-secondary)]">Fill<input type="color" value={selectedElement.fillColor || '#93c5fd'} onChange={(event) => commitElementUpdate(selectedElement.id, { fillColor: event.target.value })} className="mt-1 block h-10 w-12 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-transparent p-1" /></label>}
          {selectedElement.type !== 'text' && selectedElement.type !== 'image' && <label className="shrink-0 text-xs font-semibold text-[var(--text-secondary)]">Stroke<input type="number" min={1} max={16} value={selectedElement.strokeWidth || 2} onChange={(event) => commitElementUpdate(selectedElement.id, { strokeWidth: Math.max(1, Math.min(16, Number(event.target.value) || 2)) })} className="mt-1 block h-10 w-16 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-2 text-sm text-[var(--text-primary)]" /></label>}
          {selectedElement.type !== 'line' && selectedElement.type !== 'arrow' && <label className="shrink-0 text-xs font-semibold text-[var(--text-secondary)]">Rotate<input type="number" min={-180} max={180} value={selectedElement.rotation || 0} onChange={(event) => commitElementUpdate(selectedElement.id, { rotation: Math.max(-180, Math.min(180, Number(event.target.value) || 0)) })} className="mt-1 block h-10 w-16 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-2 text-sm text-[var(--text-primary)]" /></label>}
            : <label className="shrink-0 text-xs font-semibold text-[var(--text-secondary)]">Page<select value={selectedElement.pageIndex} onChange={(event) => { const nextPage = Number(event.target.value); commitElementUpdate(selectedElement.id, { pageIndex: nextPage }); goToPage(nextPage); }} className="mt-1 block h-10 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-2 text-sm text-[var(--text-primary)]">{Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>{index + 1}</option>)}</select></label>
        </div>
      </section>
    ) : null;

    return (
      <div
        className="min-h-[100dvh] bg-[var(--surface-canvas)]"
        style={{ paddingBottom: `calc(${immersiveBottomBarHeight}px + var(--chef-keyboard-inset, 0px))` }}
      >
        <header className="chef-chrome chef-safe-top chef-safe-x sticky top-0 z-40 border-b border-[var(--border-hairline)]">
          <div className="mx-auto flex min-h-14 max-w-4xl items-center gap-0.5 px-1.5 py-1.5">
            <button
              type="button"
              onClick={closeEditor}
              aria-label="Close editor"
              className="chef-pressable chef-target grid shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)]"
            >
              <X aria-hidden size={21} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h1 className="truncate text-base font-bold text-[var(--text-primary)]">Edit PDF</h1>
                {/* The badge is the first thing to go when the bar runs out of room. It tells the
                    reader something useful but nothing urgent, and the width it frees is what keeps
                    the word "Save" on the one control they must be able to find. */}
                <Badge tone="caution" className="shrink-0 max-[400px]:hidden">Beta</Badge>
              </div>
            </div>
            <button type="button" onClick={() => setFindOpen((open) => !open)} aria-pressed={findOpen} aria-label="Find and replace" className={`chef-pressable chef-target grid shrink-0 place-items-center rounded-[var(--radius-control)] ${findOpen ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : 'text-[var(--text-secondary)]'}`}><Search aria-hidden size={19} /></button>
            <button type="button" onClick={undo} disabled={undoStack.current.length === 0} aria-label="Undo added element change" className="chef-pressable chef-target grid shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] disabled:opacity-55"><Undo2 aria-hidden size={19} /></button>
            <button type="button" onClick={redo} disabled={redoStack.current.length === 0} aria-label="Redo added element change" className="chef-pressable chef-target grid shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] disabled:opacity-55"><Redo2 aria-hidden size={19} /></button>
            <button type="button" onClick={handleSave} disabled={status.isProcessing} aria-label="Save" className="chef-pressable chef-target inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-3 text-sm font-bold text-[var(--text-on-accent)] disabled:opacity-55"><Save aria-hidden size={17} />{/* Always spelled out. This is the one action in the editor that
                cannot be discovered by trying it, and a lone disk glyph is exactly the icon a reader
                who did not grow up with it has to guess at. The title beside it truncates instead. */}<span>Save</span></button>
          </div>
        </header>

        <div className="mx-auto w-full max-w-4xl px-2 py-2 sm:px-4">
          {(status.message || status.error) && (
            <div aria-live="polite" role={status.error ? 'alert' : 'status'} className="mb-2">
              <StatusLine tone={status.error ? 'danger' : status.progress === 100 ? 'success' : 'info'}>
                {status.error || status.message}
              </StatusLine>
            </div>
          )}

          {fillableFieldCount > 0 && (
            <p className="mb-2 px-1 text-xs font-medium text-[var(--text-secondary)]">
              Form values are not included in Undo.
            </p>
          )}

          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-0.5">
              <button type="button" onClick={() => goToPage(targetPageIndex - 1)} disabled={targetPageIndex === 0} aria-label="Previous page" className="chef-pressable chef-hit-y grid h-9 w-touch place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] disabled:opacity-55"><ChevronLeft aria-hidden size={19} /></button>
              <label className="flex h-9 items-center gap-1 px-1 text-xs font-semibold text-[var(--text-primary)]">
                <span className="sr-only">Page</span>
                <select value={targetPageIndex} onChange={(event) => goToPage(Number(event.target.value))} aria-label="Current editor page" className="h-9 bg-transparent tabular outline-none">
                  {Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>{index + 1} of {pageCount}</option>)}
                </select>
              </label>
              <button type="button" onClick={() => goToPage(targetPageIndex + 1)} disabled={targetPageIndex >= pageCount - 1} aria-label="Next page" className="chef-pressable chef-hit-y grid h-9 w-touch place-items-center rounded-[var(--radius-control)] text-[var(--text-secondary)] disabled:opacity-55"><ChevronRight aria-hidden size={19} /></button>
            </div>
            <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} />
          </div>

          <div className="overflow-hidden rounded-[var(--radius-panel)] bg-[var(--surface-sunken)]">
            <div
              ref={bindPdfZoomViewport}
              data-testid="pdf-zoom-viewport"
              data-pdf-zoom={zoom.toFixed(3)}
              className={`chef-pdf-zoom-viewport h-[calc(100dvh-20.5rem)] min-h-64 max-h-[48rem] overflow-x-auto overflow-y-auto p-2 sm:p-8 ${insertMode ? 'cursor-crosshair' : ''}`}
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
                onSelect={setSelectedId}
                onUpdate={updateElement}
                onBeginElementChange={rememberSnapshot}
                onDelete={deleteElement}
                onFormValueChange={updateFormValue}
                onPagePress={handlePagePress}
                blockEdits={blockEdits}
                activeBlockId={activeBlockId}
                coarsePointer={coarsePointer}
                cachedText={readCachedPageText}
                onBlocksReady={handleBlocksReady}
                onActivateBlock={handleActivateBlock}
                onBlockChange={handleBlockChange}
                onBeginBlockChange={handleBeginBlockChange}
                insertMode={insertMode}
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
          className="chef-chrome chef-safe-bottom chef-safe-x fixed inset-x-0 z-40 border-t border-[var(--border-hairline)] px-2 pb-2 pt-2"
        >
          {findBar}
          {scannedNotice}
          {blockedNotice}
          {paragraphInspector(true)}
          {selectedInspector}
          {insertMode && (
            <div aria-live="polite" className="mx-auto mb-1 max-w-md text-center text-xs font-semibold text-[var(--accent-text)]">
              Tap the page to place {insertMode === 'text' ? 'text' : `a ${shapeKind}`}.
            </div>
          )}
          <div role="toolbar" aria-label="Add content" className="mx-auto grid max-w-md grid-cols-[1fr_1fr_1fr_minmax(6.5rem,1.25fr)] gap-1">
            <button
              type="button"
              aria-pressed={insertMode === 'text'}
              onClick={(event) => {
                if (event.detail === 0) addText();
                else setInsertMode((current) => current === 'text' ? null : 'text');
              }}
              className={`chef-pressable chef-target flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-[var(--radius-control)] text-xs font-bold ${insertMode === 'text' ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : 'text-[var(--text-secondary)]'}`}
            ><Type aria-hidden size={19} /><span>Text</span></button>
            <button type="button" onClick={() => imageInputRef.current?.click()} className="chef-pressable chef-target flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-[var(--radius-control)] text-xs font-bold text-[var(--text-secondary)]"><ImagePlus aria-hidden size={19} /><span>Image</span></button>
            <button
              type="button"
              aria-pressed={insertMode === 'shape'}
              onClick={(event) => {
                if (event.detail === 0) addShape();
                else setInsertMode((current) => current === 'shape' ? null : 'shape');
              }}
              className={`chef-pressable chef-target flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-[var(--radius-control)] text-xs font-bold ${insertMode === 'shape' ? 'bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : 'text-[var(--text-secondary)]'}`}
            ><Shapes aria-hidden size={19} /><span>Shape</span></button>
            <label className="flex min-h-11 min-w-0 items-center rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2">
              <span className="sr-only">Shape type</span>
              <select value={shapeKind} onChange={(event) => { setShapeKind(event.target.value as EditorElement['type']); setInsertMode('shape'); }} aria-label="Shape type" className="h-10 min-w-0 w-full bg-transparent text-xs font-semibold text-[var(--text-primary)] outline-none">
                <option value="rectangle">Rectangle</option><option value="ellipse">Ellipse</option><option value="line">Line</option><option value="arrow">Arrow</option>
              </select>
            </label>
          </div>
          <input ref={imageInputRef} type="file" accept=".png,.jpg,.jpeg,image/png,image/jpeg" className="hidden" onChange={(event) => { void addImage(event.target.files?.[0]); event.currentTarget.value = ''; }} />
        </div>
      </div>
    );
  }

  return (
    <div className={`mx-auto w-full max-w-6xl px-4 py-4 sm:py-6 ${file ? '' : 'chef-tool-landing-centered'}`}>
       <div className="mb-3 flex flex-col gap-2">
          <div>
            <h1 className="text-2xl font-bold">Edit PDF <Badge tone="caution" className="align-middle">Beta</Badge></h1>
            {/* Kept: this is a beta editor and the export is what gets shared. */}
            <p className="mt-1 text-sm font-medium text-[var(--status-caution-text)]">Review the result before sharing.</p>
          </div>
          {file && (
             <div role="toolbar" aria-label="PDF editor tools" className="flex flex-wrap items-center gap-2 rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-2">
                <button type="button" onClick={() => goToPage(targetPageIndex - 1)} disabled={targetPageIndex === 0} aria-label="Previous page" className="chef-hit-y chef-pressable flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--border-strong)] text-[var(--text-secondary)] disabled:opacity-55"><ChevronLeft size={20} /></button>
                <label className="flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 text-sm font-semibold text-[var(--text-primary)]">
                  Page
                  <select value={targetPageIndex} onChange={(event) => goToPage(Number(event.target.value))} aria-label="Current editor page" className="min-h-11 bg-transparent outline-none">
                    {Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>{index + 1} of {pageCount}</option>)}
                  </select>
                </label>
                <button type="button" onClick={() => goToPage(targetPageIndex + 1)} disabled={targetPageIndex >= pageCount - 1} aria-label="Next page" className="chef-hit-y chef-pressable flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--border-strong)] text-[var(--text-secondary)] disabled:opacity-55"><ChevronRight size={20} /></button>
                <span className="mx-1 hidden h-7 w-px bg-[var(--border-hairline)] sm:block" aria-hidden="true" />
                <button type="button" onClick={undo} disabled={undoStack.current.length === 0} aria-label="Undo added element change" className="chef-hit-y chef-pressable flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text-secondary)] disabled:opacity-55"><Undo2 size={18} /></button>
                <button type="button" onClick={redo} disabled={redoStack.current.length === 0} aria-label="Redo added element change" className="chef-hit-y chef-pressable flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text-secondary)] disabled:opacity-55"><Redo2 size={18} /></button>
                <button type="button" onClick={() => setFindOpen((open) => !open)} aria-pressed={findOpen} className={`chef-hit-y chef-pressable flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border px-4 font-bold ${findOpen ? 'border-[var(--accent-rest)] bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]' : 'border-[var(--border-strong)] text-[var(--text-primary)] hover:border-[var(--accent-rest)]'}`}><Search size={18}/> Find</button>
                <button type="button" onClick={() => addText()} className="chef-hit-y chef-pressable flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-4 font-bold text-[var(--text-primary)] hover:border-[var(--accent-rest)]"><Type size={18}/> Text</button>
                <button type="button" onClick={() => imageInputRef.current?.click()} className="chef-hit-y chef-pressable flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-4 font-bold text-[var(--text-primary)] hover:border-[var(--accent-rest)]"><ImagePlus size={18}/> Image</button>
                <input ref={imageInputRef} type="file" accept=".png,.jpg,.jpeg,image/png,image/jpeg" className="hidden" onChange={(event) => { void addImage(event.target.files?.[0]); event.currentTarget.value = ''; }} />
                <div className="flex min-h-11 flex-wrap overflow-hidden rounded-[var(--radius-control)] border border-[var(--border-strong)]">
                  <select value={shapeKind} onChange={(event) => setShapeKind(event.target.value as EditorElement['type'])} aria-label="Shape type" className="min-h-11 border-0 bg-[var(--surface-raised)] px-2 text-sm font-semibold text-[var(--text-primary)] outline-none">
                    <option value="rectangle">Rectangle</option><option value="ellipse">Ellipse</option><option value="line">Line</option><option value="arrow">Arrow</option>
                  </select>
                  <button type="button" onClick={() => addShape()} aria-label={`Add ${shapeKind}`} className="chef-hit-y chef-pressable flex min-h-11 items-center gap-1 border-l border-[var(--border-strong)] px-3 font-bold text-[var(--text-primary)]"><Shapes size={18}/> Add</button>
                </div>
                <button type="button" onClick={handleSave} disabled={status.isProcessing} className="chef-hit-y chef-pressable flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent-rest)] px-6 font-bold text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)] disabled:opacity-55"><Save size={18}/> Save</button>
             </div>
          )}
          {findBar}
          {scannedNotice}
          {blockedNotice}
          {paragraphInspector(false)}
          {selectedElement && (
            <div role="region" aria-label={`Selected ${selectedElement.type} properties`} className="rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] px-3 py-2">
              <div className="flex flex-wrap items-end gap-2">
                <span className="pb-2.5 text-xs font-semibold uppercase tracking-[0.15em] text-[var(--text-secondary)]">Selected {selectedElement.type}</span>
                {selectedElement.type === 'text' && <label className="min-w-0 flex-1 basis-[220px] text-xs font-semibold text-[var(--text-secondary)]">Text<input value={selectedElement.content} onChange={(event) => updateInspectorText(selectedElement.id, event.currentTarget.value)} onBlur={finishInspectorTextChange} className="mt-1 h-11 w-full rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-rest)] focus:shadow-[inset_0_0_0_1px_var(--accent-rest)]" /></label>}
                {selectedElement.type !== 'image' && <label className="text-xs font-semibold text-[var(--text-secondary)]">Colour<input type="color" value={selectedElement.color || '#2563eb'} onChange={(event) => commitElementUpdate(selectedElement.id, { color: event.target.value })} className="mt-1 block h-11 w-12 rounded border border-[var(--border-strong)] bg-transparent p-1" /></label>}
                {selectedElement.type === 'text' && <label className="text-xs font-semibold text-[var(--text-secondary)]">Font<select value={selectedElement.fontFamily || 'Helvetica'} onChange={(event) => commitElementUpdate(selectedElement.id, { fontFamily: event.target.value })} className="mt-1 block h-11 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-2 text-sm text-[var(--text-primary)]"><option value="Helvetica">Helvetica</option><option value="TimesRoman">Times</option><option value="Courier">Courier</option></select></label>}
                {selectedElement.type === 'text' && <label className="text-xs font-semibold text-[var(--text-secondary)]">Size<input type="number" min={8} max={72} value={selectedElement.fontSize || 16} onChange={(event) => commitElementUpdate(selectedElement.id, { fontSize: normalizeInspectorFontSize(selectedElement, event.target.value) })} className="mt-1 block h-11 w-20 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-2 text-sm text-[var(--text-primary)]" /></label>}
                {(selectedElement.type === 'rectangle' || selectedElement.type === 'ellipse') && <label className="flex min-h-11 items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]"><input type="checkbox" checked={Boolean(selectedElement.fillColor && selectedElement.fillColor !== 'transparent')} onChange={(event) => commitElementUpdate(selectedElement.id, { fillColor: event.target.checked ? '#93c5fd' : 'transparent' })} className="h-5 w-5" /> Fill</label>}
                {(selectedElement.type === 'rectangle' || selectedElement.type === 'ellipse') && selectedElement.fillColor !== 'transparent' && <label className="text-xs font-semibold text-[var(--text-secondary)]">Fill colour<input type="color" value={selectedElement.fillColor || '#93c5fd'} onChange={(event) => commitElementUpdate(selectedElement.id, { fillColor: event.target.value })} className="mt-1 block h-11 w-12 rounded border border-[var(--border-strong)] bg-transparent p-1" /></label>}
                {selectedElement.type !== 'text' && selectedElement.type !== 'image' && <label className="text-xs font-semibold text-[var(--text-secondary)]">Stroke<input type="number" min={1} max={16} value={selectedElement.strokeWidth || 2} onChange={(event) => commitElementUpdate(selectedElement.id, { strokeWidth: Math.max(1, Math.min(16, Number(event.target.value) || 2)) })} className="mt-1 block h-11 w-20 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-2 text-sm text-[var(--text-primary)]" /></label>}
                {selectedElement.type !== 'line' && selectedElement.type !== 'arrow' && <label className="text-xs font-semibold text-[var(--text-secondary)]">Rotate<input type="number" min={-180} max={180} value={selectedElement.rotation || 0} onChange={(event) => commitElementUpdate(selectedElement.id, { rotation: Math.max(-180, Math.min(180, Number(event.target.value) || 0)) })} className="mt-1 block h-11 w-20 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-2 text-sm text-[var(--text-primary)]" /></label>}
                  : <label className="text-xs font-semibold text-[var(--text-secondary)]">Page<select value={selectedElement.pageIndex} onChange={(event) => { const nextPage = Number(event.target.value); commitElementUpdate(selectedElement.id, { pageIndex: nextPage }); goToPage(nextPage); }} className="mt-1 block h-11 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] px-2 text-sm text-[var(--text-primary)]">{Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>{index + 1}</option>)}</select></label>
                <button type="button" onClick={() => deleteElement(selectedElement.id)} className="chef-hit-y chef-pressable inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-control)] border border-[var(--status-danger-text)] px-3 text-sm font-bold text-[var(--status-danger-text)] hover:bg-[var(--status-danger-quiet)]"><Trash2 size={16}/> Delete</button>
              </div>
            </div>
          )}
          {file && fillableFieldCount > 0 && (
            <p className="px-1 text-xs font-medium text-[var(--text-secondary)]">
              Form values are not included in Undo.
            </p>
          )}
          {file && (status.message || status.error) && (
            <div aria-live="polite" role={status.error ? 'alert' : 'status'}>
              <StatusLine tone={status.error ? 'danger' : status.progress === 100 ? 'success' : 'info'}>
                {status.error || status.message}
              </StatusLine>
            </div>
          )}
       </div>

       <AnimatePresence mode="wait">
          {!file ? (
             <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mx-auto w-full max-w-xl">
                <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label="Choose a PDF to edit" />
             </motion.div>
          ) : (
             <div className="relative overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)]">
                <div className="flex justify-end border-b border-[var(--border-hairline)] bg-[var(--surface-raised)] px-2 py-1.5 [&_button]:h-11 [&_button]:w-11 [&_button]:p-0">
                  <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} />
                </div>
                <div
                  ref={bindPdfZoomViewport}
                  data-testid="pdf-zoom-viewport"
                  data-pdf-zoom={zoom.toFixed(3)}
                  className="chef-pdf-zoom-viewport h-[70dvh] min-h-96 max-h-[48rem] overflow-x-auto overflow-y-auto p-2 sm:p-8"
                >
                      <PDFPage
                          key={targetPageIndex} pageIndex={targetPageIndex} pageCount={pageCount} pdfDoc={pdfDoc}
                          elements={elements.filter(e => e.pageIndex === targetPageIndex)}
                          formFields={formFields.filter((field) => field.pageIndex === targetPageIndex)}
                          formValues={formValues}
                          selectedId={selectedId} onSelect={setSelectedId}
                          onUpdate={updateElement} onBeginElementChange={rememberSnapshot} onDelete={deleteElement}
                          onFormValueChange={updateFormValue}
                          onPagePress={() => setSelectedId(null)}
                          blockEdits={blockEdits}
                          activeBlockId={activeBlockId}
                          coarsePointer={coarsePointer}
                          cachedText={readCachedPageText}
                          onBlocksReady={handleBlocksReady}
                          onActivateBlock={handleActivateBlock}
                          onBlockChange={handleBlockChange}
                          onBeginBlockChange={handleBeginBlockChange}
                          insertMode={null}
                          zoom={zoom}
                      />
                </div>
             </div>
          )}
       </AnimatePresence>
    </div>
  );
};
