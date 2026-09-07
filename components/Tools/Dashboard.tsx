import React, { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Search, ShieldCheck, X } from 'lucide-react';
import { categoryOrder, tools } from './toolCatalog';
import type { ToolCardData, ToolCategory } from './toolCatalog';
import { matchesToolSearchQuery, toolSearchScore } from '../../services/toolSearch';
import { TabHeader } from '../Layout/AppShell';
import { Badge, Button, EmptyState, cx } from '../UI/Primitives';
import { useHaptics } from '../../hooks/useWorkspaceRuntime';
import { ToolIdentity } from './ToolIdentity';

type CategoryFilter = 'All' | ToolCategory;

/**
 * The bubble wash behind each mark, recovered from the Android app's
 * `ToolVisuals.kt` palette seeds. Category tinting was tried here and failed on
 * two counts: the four tints said nothing the counted filter above the list did
 * not already say, and they disagreed with the artwork inside them — a green
 * bubble under a red-and-grey compressor. Worse, in dark theme the Edit tint
 * resolved to `--ink-900`, so fourteen of the thirty-four rows carried a
 * saturated maroon block and the catalog read as a list of errors.
 *
 * These seeds are the colours the marks were drawn from, so the wash agrees
 * with its icon instead of competing with it. Stored as `R G B` and composited
 * at 13% over whatever surface is behind them, which is Android's own dark
 * formula and within a point of its light one — and, unlike `color-mix`, it
 * adapts to both themes on the WebKit versions this app still supports.
 */
const TOOL_TINT: Record<string, string> = {
  MAKE_PDF: '228 33 33',
  COMPRESS: '111 124 144',
  MERGE: '228 33 33',
  SPLIT: '215 106 69',
  EDIT_PDF: '231 90 107',
  MAKE_FILLABLE: '46 141 138',
  SIGN_PDF: '231 90 107',
  WATERMARK: '228 33 33',
  PROTECT: '111 124 144',
  UNLOCK: '209 138 31',
  DELETE_PAGES: '228 33 33',
  PAGE_NUMBERS: '111 124 144',
  REORDER_PAGES: '111 124 144',
  ROTATE_PAGES: '209 138 31',
  FLATTEN_PDF: '111 124 144',
  EXTRACT_PAGES: '209 138 31',
  JPG_TO_PDF: '46 141 138',
  PDF_TO_JPG: '83 170 144',
  PDF_TO_DOC: '46 141 138',
  DOC_TO_PDF: '46 141 138',
  PPTX_TO_PDF: '215 106 69',
  OCR_TEXT: '46 141 138',
  METADATA: '111 124 144',
  REPAIR_PDF: '215 106 69',
  COMPARE_PDF: '115 148 59',
};

/**
 * Reader and the web-only tools have no generated mark to take a colour from,
 * so they take the product's own logo red rather than an invented hue. Android
 * seeds five of its tools from exactly this colour, so the rows sit in the same
 * family instead of reading as a lesser tier of the catalog.
 */
const BRAND_TINT = '228 33 33';

const tintFor = (tool: ToolCardData) =>
  (tool.androidTool && TOOL_TINT[tool.androidTool]) || BRAND_TINT;

const homeTools: ToolCardData[] = [
  ...tools.filter((tool) => tool.path === '/make-pdf'),
  ...tools.filter((tool) => tool.path === '/view'),
  ...tools.filter((tool) => tool.path !== '/make-pdf' && tool.path !== '/view'),
];

/**
 * Android's proportional segment weights, so the strip keeps the same shape:
 * the longest label gets the most room instead of every option getting a fifth
 * of the width. They are grow factors over natural width, so a label is never
 * squeezed — if the five no longer fit on one line they wrap onto a second.
 */
const CATEGORY_WEIGHT: Record<CategoryFilter, number> = {
  All: 4,
  Create: 6,
  Edit: 4,
  Optimize: 8,
  Convert: 7,
  Secure: 6,
};

/**
 * Android's home row, to the dp: 72px minimum, 14x10 padding, a 48px bubble
 * carrying 32px of generated artwork, 14px to the text, a 14/20 SemiBold name
 * and a 22px chevron. The bubble, its radius and the paddings stay in px so the
 * icon column, and therefore the divider, holds its position while the type
 * scales; the row's own height is a minimum, so it grows.
 *
 * The row is a name and a mark. The subtitle under each one restated what the
 * name already said, thirty-four times down a phone screen.
 */
/**
 * The subtitle under each row in the tool list. It started as an exact copy of
 * Android's home catalogue, and a few of those lines named parts of the file
 * format ('fillable fields', 'bakes form fields') rather than the job. This is
 * the list everyone browses, so it reads as the job.
 */
const ANDROID_HOME_SUBTITLES: Record<string, string> = {
  MAKE_PDF: 'Scan paper with the camera',
  COMPRESS: 'Same pages, smaller file',
  MERGE: 'Several files in, one out',
  SPLIT: 'One file in, several files out',
  EDIT_PDF: 'Retype text, add shapes and images',
  MAKE_FILLABLE: 'Adds boxes people can type into',
  SIGN_PDF: 'Your handwriting, not a legal seal',
  WATERMARK: 'Stamps your mark on every page',
  PROTECT: 'Adds a password to open it',
  UNLOCK: 'Needs the current password',
  DELETE_PAGES: 'Drops the pages you pick',
  PAGE_NUMBERS: 'Numbers every page for you',
  REORDER_PAGES: 'Drag pages into a better order',
  ROTATE_PAGES: 'For pages that came out sideways',
  FLATTEN_PDF: 'Locks filled answers for good',
  EXTRACT_PAGES: 'Keeps only the pages you pick',
  JPG_TO_PDF: 'Photos in, one tidy PDF out',
  PDF_TO_JPG: 'Every page becomes a picture',
  PDF_TO_DOC: 'A Word file; needs real words, not a scan',
  DOC_TO_PDF: 'Text only, and .docx files only',
  PPTX_TO_PDF: '.pptx slides only; some fonts may change',
  OCR_TEXT: 'Lifts the words out as plain text',
  METADATA: 'Title, author and other quiet details',
  REPAIR_PDF: 'Fixes minor issues only',
  COMPARE_PDF: 'A quick overview, not a page-by-page check',
};

const subtitleFor = (tool: ToolCardData) =>
  tool.androidTool ? ANDROID_HOME_SUBTITLES[tool.androidTool] ?? tool.description : tool.description;

const ToolRow: React.FC<{ tool: ToolCardData; eager?: boolean }> = ({ tool, eager = false }) => {
  const haptic = useHaptics();
  const displayName = tool.path === '/view' ? 'Read PDF' : tool.name;
  const subtitle = subtitleFor(tool);

  return (
    <Link
      to={tool.path}
      onPointerDown={() => haptic('selection')}
      className="chef-pressable chef-pressable-row flex min-h-[72px] items-center gap-[14px] px-[14px] py-[10px] outline-none focus-visible:bg-[var(--surface-sunken)] md:min-h-[56px] md:gap-3 md:px-3 md:py-2"
    >
      <span
        aria-hidden
        style={{ backgroundColor: `rgb(${tintFor(tool)} / 0.13)` }}
        className="grid h-[48px] w-[48px] shrink-0 place-items-center rounded-[12px] md:h-[40px] md:w-[40px]"
      >
        <ToolIdentity
          tool={tool}
          eager={eager}
          size={22}
          assetSize={32}
          className="text-[var(--accent-on-quiet)]"
          assetClassName="h-[32px] w-[32px] object-contain md:h-[28px] md:w-[28px]"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="chef-wrap-words text-[0.875rem] font-semibold leading-[1.4286] text-[var(--text-primary)] md:text-[0.9375rem]">
            {displayName}
          </span>
          {tool.beta && (
            <Badge tone="caution" className="!px-1.5 !text-[0.75rem] !tracking-[0.06em]">
              Beta
            </Badge>
          )}
          {tool.availability === 'android-only' && (
            <Badge tone="neutral" className="!px-1.5 !text-[0.75rem] !tracking-[0.06em]">
              Not available
            </Badge>
          )}
        </span>
        {/* One quiet line under the name, as on the Android home screen. Regular
            weight rather than medium: thirty-four of these stacked at 12px were
            competing with the titles they sit under. */}
        <span className="chef-clamp-2 mt-0.5 block text-[0.75rem] font-normal leading-[1.3333] text-[var(--text-secondary)]">
          {subtitle}
        </span>
      </span>
      {/* Android draws this at 0.72 alpha. Thirty-four of them make a column of
          their own, and at full strength that column competes with the titles. */}
      <ChevronRight aria-hidden size={22} className="shrink-0 text-[var(--text-tertiary)] opacity-70" />
    </Link>
  );
};

export const Dashboard: React.FC = () => {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('All');
  const deferredQuery = useDeferredValue(query);
  const searchRef = useRef<HTMLInputElement>(null);

  const categoryCounts = useMemo(() => {
    const counts: Record<CategoryFilter, number> = { All: tools.length, Create: 0, Edit: 0, Convert: 0, Secure: 0, Optimize: 0 };
    for (const tool of tools) counts[tool.category] += 1;
    return counts;
  }, []);

  const trimmed = deferredQuery.trim();
  const searching = trimmed.length > 0;

  const filteredTools = useMemo(() => {
    const source = searching ? tools : homeTools;
    const matches = source.filter(
      (tool) => (category === 'All' || tool.category === category) && matchesToolSearchQuery(tool, trimmed),
    );

    if (!searching) return matches;

    return matches.sort((left, right) => {
      const scoreDelta = toolSearchScore(right, trimmed) - toolSearchScore(left, trimmed);
      if (scoreDelta !== 0) return scoreDelta;
      return tools.indexOf(left) - tools.indexOf(right);
    });
  }, [category, searching, trimmed]);

  const reset = useCallback(() => {
    setQuery('');
    setCategory('All');
    searchRef.current?.focus();
  }, []);

  // Now that this line is read as well as announced, it has to parse as a
  // sentence and it has to say which query it is reporting on.
  const resultSummary = searching
    ? `${filteredTools.length} ${filteredTools.length === 1 ? 'tool matches' : 'tools match'} “${trimmed}”`
    : '';

  return (
    <>
      <TabHeader
        title="PDF Chef"
        leading={
          // Android's 50dp mark at the reader's default text size, and smaller
          // as that text grows: the mark is fixed artwork beside a name that
          // scales, so at 200% it was taking a third of a 320px line away from
          // the product's own name. Dividing by the scale keeps the two in
          // proportion, and the floor stops it from disappearing.
          <img
            src="/pdf-chef-logo-exact.webp"
            alt=""
            aria-hidden
            width={50}
            height={50}
            style={{
              width: 'clamp(32px, calc(50px / var(--text-scale, 1)), 50px)',
              height: 'clamp(32px, calc(50px / var(--text-scale, 1)), 50px)',
            }}
            className="shrink-0 object-contain md:hidden"
          />
        }
      />

      {/* The page padding sits outside the measure, exactly as `TabHeader` sets
          it up, so the title, the assurance line, the field and the list all
          share one left edge. Nested inside the measure it lost 32px at desktop
          widths and everything below the title sat inset from it. */}
      <div className="px-4 md:px-8">
        <div className="mx-auto max-w-4xl">
          {/* A statement that is always true does not need a container. This was
              a bordered, shadowed 46px card sitting directly above a bordered
              38px field and a bordered 46px strip: three lozenges of nearly the
              same height, radius and weight, and no hierarchy between them.
              As a line it belongs to the title above it, the field below it
              becomes the one control in the header, and at 200% text it wraps
              from the glyph instead of centring four lines against it. */}
          <div role="note" className="flex items-start gap-2">
            {/* Sized in rem, unlike the tool bubbles: nothing keys off this
                chip's edge, so it can stay in proportion to the sentence it
                marks instead of shrinking to a dot at 200% text. */}
            <span
              aria-hidden
              className="mt-[0.0625rem] grid h-[1.375rem] w-[1.375rem] shrink-0 place-items-center rounded-[0.4375rem] bg-[var(--status-success-quiet)] text-[var(--status-success-text)]"
            >
              <ShieldCheck size={14} className="h-[0.875rem] w-[0.875rem]" />
            </span>
            <p className="chef-wrap-words min-w-0 text-[0.8125rem] leading-[1.4]">
              <span className="font-semibold text-[var(--status-success-text)]">Processed on this device.</span>{' '}
              <span className="font-medium text-[var(--text-secondary)]">Nothing is uploaded.</span>
            </p>
          </div>
        </div>
      </div>

      {/* Search sits above the filter, because a typed query outranks a tapped
          one. It rides with the page on phones, the way the Android list does;
          on a tall desktop window it sticks, because there the list runs far
          enough past the fold for the field to be worth keeping. The sticky
          element is the full-width one, so the backing colour reaches the
          window edges rather than stopping at the measure. */}
      <div className="mt-3 px-4 md:sticky md:top-0 md:z-20 md:bg-[var(--surface-canvas)] md:px-8 md:pb-3 md:pt-2">
        <div className="mx-auto max-w-4xl">
          {/* 38px of visual inside a 48px target: the label takes the extra
              five pixels a side back out of the layout, so the rhythm stays
              Android's and the pressable region still clears the touch floor.

              The prompt is one word, not the Android field's five. A single
              unwrappable line of "Smart search tools..." read as "Smart search
              to" at 200% text, which is a prompt that has stopped prompting.
              A 320px screen at 200% leaves about 190px for the prompt and the
              interface font is the reader's choice, so two words are not safe
              across Manrope, a serif or a monospace. One word renders in full
              in every combination; the accessible name still states the full
              scope, and the glyph beside it is what makes the field a search
              field whether or not anything is typed. */}
          <label
            htmlFor="tool-search"
            className="relative -my-[5px] flex min-h-touch w-full items-center"
          >
            <Search
              aria-hidden
              size={20}
              className="pointer-events-none absolute left-[16px] top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
            />
            <input
              ref={searchRef}
              id="tool-search"
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              aria-label={`Search ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`}
              aria-describedby="tool-search-status"
              className={cx(
                // Android's field is 16sp Medium, and so is its prompt. Bold
                // was making an empty field read as a heading rather than as
                // something to type into.
                'w-full rounded-[22px] border border-[var(--border-strong)] bg-[var(--surface-raised)] py-[0.4375rem] pl-[46px] text-[1rem] font-medium leading-[1.375] text-[var(--text-primary)] outline-none transition-colors duration-transition ease-settle placeholder:font-medium placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent-rest)]',
                // The trailing 44px is reserved only while the clear control is
                // actually there, so the empty field gives that width back to
                // the prompt at large text sizes.
                query ? 'pr-[46px]' : 'pr-[16px]',
              )}
            />
            {query && (
              <button
                type="button"
                onClick={reset}
                aria-label="Clear search"
                className="chef-pressable chef-target absolute right-0 top-1/2 grid -translate-y-1/2 place-items-center rounded-[var(--radius-pill)] text-[var(--text-secondary)]"
              >
                <X aria-hidden size={20} />
              </button>
            )}
          </label>

          {/* The live region stays mounted so announcements keep working, and
              it shows itself once it has something to report. A prompt vanishes
              the moment someone types; this is the line that stays, states what
              the field just did, and wraps instead of clipping at any text
              size. */}
          <p
            id="tool-search-status"
            role="status"
            aria-live="polite"
            className={cx(
              searching
                ? 'chef-wrap-words mt-2 px-1 text-[0.75rem] font-medium leading-[1.3333] text-[var(--text-secondary)]'
                : 'sr-only',
            )}
          >
            {resultSummary}
          </p>

          {/* 46px shell, 3px inset, 38px segments. At normal phone text sizes
              the five share one row, matching Android without wasting a second
              row on a lone category. They may still wrap under text zoom so
              every category stays reachable without horizontal scrolling.

              Selection is a raised chip on a sunken track — the shape a native
              segmented control uses — rather than a flat red field. Android
              gets its structure from a hairline between every pair of segments,
              which a wrapping strip cannot keep; the chip supplies the same
              structure and survives the wrap. The accent stays, on the label,
              because selection is one of the things the accent is for.

              The two gaps differ on purpose. Side by side, 2px is the Android
              spacing and the height-only hit extension keeps the segments out
              of each other. Once the strip wraps, the extension reaches five
              pixels above and below each 38px segment, so the rows need ten
              between them or two targets would overlap. At default text the
              five fit on one line and the row gap never appears. */}
          <div
            role="group"
            aria-label="Filter tools by category"
            className="mt-3 flex w-full flex-wrap items-stretch gap-x-[2px] gap-y-[10px] rounded-[20px] border border-[var(--border-hairline)] bg-[var(--surface-sunken)] p-[3px] md:w-fit md:max-w-full"
          >
            {categoryOrder.map((item) => {
              const selected = item === category;
              const count = categoryCounts[item];
              return (
                <button
                  key={item}
                  type="button"
                  aria-pressed={selected}
                  aria-label={`${item}, ${count} ${count === 1 ? 'tool' : 'tools'}`}
                  onClick={() => setCategory(item)}
                  style={{ flexGrow: CATEGORY_WEIGHT[item] }}
                  className={cx(
                    'chef-pressable chef-hit-y flex min-h-[38px] min-w-touch grow basis-0 items-center justify-center whitespace-nowrap rounded-[var(--radius-row)] px-[5px] py-1 md:grow-0 md:basis-auto',
                    'text-[0.75rem] leading-[1.3333] transition-colors duration-transition ease-settle min-[360px]:text-[0.8125rem] min-[420px]:text-[0.875rem]',
                    selected
                      ? 'bg-[var(--surface-raised)] font-semibold text-[var(--accent-on-quiet)] shadow-[var(--elevation-raised)] ring-1 ring-inset ring-[var(--border-strong)]'
                      : 'font-medium text-[var(--text-secondary)]',
                  )}
                >
                  <span aria-hidden>{item}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="px-4 md:px-8">
        <div className="mx-auto max-w-4xl">
          {filteredTools.length === 0 ? (
            <EmptyState
              icon={<Search size={30} />}
              title="No tool matches that"
              body="Try a plainer word for what you want to do — like smaller, sign, password, or photo."
              action={
                <Button tone="secondary" onClick={reset}>
                  Clear search and filter
                </Button>
              }
            />
          ) : (
            <ul className="chef-divided-list mt-3.5 overflow-hidden rounded-[var(--radius-row)] border border-[var(--border-hairline)] bg-[var(--surface-raised)]">
              {filteredTools.map((tool, index) => (
                <li key={tool.id}>
                  {/* Only the rows that can be on screen at first paint fetch
                      eagerly; the rest of the catalog decodes as it is reached. */}
                  <ToolRow tool={tool} eager={index < 5} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
};
