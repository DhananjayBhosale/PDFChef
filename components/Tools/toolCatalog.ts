import {
  ArrowDownUp,
  Banknote,
  Crop,
  Database,
  Droplets,
  Edit3,
  Eye,
  Receipt,
  FileDown,
  FileImage,
  FileOutput,
  FileSignature,
  FileStack,
  FileText,
  HandCoins,
  FileType2,
  FormInput,
  GitCompare,
  Hash,
  Heading,
  Image as ImageIcon,
  Lock,
  Minimize2,
  Presentation,
  RotateCw,
  ScanSearch,
  Scissors,
  ShieldOff,
  Smartphone,
  StickyNote,
  Trash2,
  Unlock,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Mirrors `ToolCategory` in the Android app (`data/model/PdfTool.kt`).
 */
export type ToolCategory = 'Create' | 'Edit' | 'Convert' | 'Secure' | 'Optimize';

export type ToolColor =
  | 'orange'
  | 'teal'
  | 'purple'
  | 'blue'
  | 'red'
  | 'rose'
  | 'sky'
  | 'cyan'
  | 'green'
  | 'yellow'
  | 'indigo'
  | 'violet'
  | 'amber'
  | 'emerald'
  | 'lime'
  | 'slate';

/**
 * `web` runs entirely in this browser build.
 * `android-only` has no browser-side implementation; the route stays live and says so.
 */
export type ToolAvailability = 'web' | 'android-only';

export interface ToolCardData {
  id: number;
  name: string;
  icon: LucideIcon;
  /** Exact Android-generated artwork for shared tools; omitted for Reader and web-only tools. */
  iconAsset?: string;
  category: ToolCategory;
  /** What *this* browser build does. Not always the Android subtitle — see `androidSubtitle`. */
  description: string;
  color: ToolColor;
  path: string;
  /**
   * Matching `PdfTool` enum constant in the Android app, or `READER` for the Android
   * reader surface. Omitted for tools that exist only on the web.
   */
  androidTool?: string;
  /** `PdfTool.title` in the Android app, when it differs from `name` (BETA suffix). */
  androidTitle?: string;
  /**
   * `PdfTool.subtitle` in the Android app, verbatim.
   *
   * Most tools no longer carry one: the app dropped every subtitle that only restated its
   * title, and now writes a second line only where the title alone could be misread — that
   * flattening bakes form fields rather than rasterizing pages, that unlocking needs the
   * password rather than breaking it, that text export reads an existing text layer rather
   * than running OCR. This field is therefore omitted for the majority of entries, and for
   * web-only tools, and `description` carries the card copy on its own.
   */
  androidSubtitle?: string;
  availability: ToolAvailability;
  beta?: boolean;
  /**
   * Search aliases. For shared tools these are `toolSearchAliases` from the Android app
   * (`ui/app/ToolSearch.kt`) verbatim, so the same phrasing finds the same tool on both
   * surfaces. The app matches queries against these aliases rather than against subtitles,
   * which is why dropping the subtitles cost it no discoverability.
   */
  keywords?: string[];
}

/**
 * Every `PdfTool` constant in the Android app, in the app's own popularity order
 * (`PdfTool.POPULARITY_ORDER`, which is also the Home list order). `READER` is the reader
 * surface, which is not a `PdfTool` but is reachable from the app shell and maps to `/view`.
 *
 * `npm run test:catalog` checks this list against `tools` below, so a tool added to,
 * renamed in, or reordered in the Android app fails the check until the site catalog follows.
 */
export const ANDROID_TOOLS = [
  'READER',
  'MAKE_PDF',
  'COMPRESS',
  'MERGE',
  'SPLIT',
  'EDIT_PDF',
  'MAKE_FILLABLE',
  'SIGN_PDF',
  'WATERMARK',
  'PROTECT',
  'UNLOCK',
  'DELETE_PAGES',
  'PAGE_NUMBERS',
  'REORDER_PAGES',
  'ROTATE_PAGES',
  'FLATTEN_PDF',
  'EXTRACT_PAGES',
  'JPG_TO_PDF',
  'PDF_TO_JPG',
  'PDF_TO_DOC',
  'DOC_TO_PDF',
  'PPTX_TO_PDF',
  'OCR_TEXT',
  'METADATA',
  'REPAIR_PDF',
  'COMPARE_PDF',
] as const;

/**
 * Ordered to match the Android home screen: shared tools in the app's popularity
 * order, then the browser-only tools that have no Android counterpart.
 *
 * `name` is `PdfTool.title` from the app, with the app's `(BETA)` suffix carried by the
 * `beta` flag instead of the string. `description` states what *this* build does; where
 * the browser tool is narrower or wider than the Android one (Create PDF, Edit PDF,
 * Extract Text) the copy says so rather than borrowing the Android subtitle, which stays
 * recorded in `androidSubtitle`.
 */
export const tools: ToolCardData[] = [
  {
    id: 1,
    name: 'View PDF',
    icon: Eye,
    category: 'Edit',
    description: 'Open a PDF and send it to any tool',
    color: 'blue',
    path: '/view',
    androidTool: 'READER',
    availability: 'web',
    keywords: ['view', 'open', 'read', 'reader', 'preview', 'viewer', 'open pdf', 'read pdf'],
  },
  {
    id: 2,
    name: 'Create PDF',
    icon: Smartphone,
    iconAsset: '/tool-icons/tool_icon_create_pdf.png',
    category: 'Convert',
    // Android drives the ML Kit document scanner; the browser has camera capture and file pick.
    description: 'Capture or import photos into a clean PDF',
    color: 'red',
    path: '/make-pdf',
    androidTool: 'MAKE_PDF',
    androidSubtitle: 'Scan paper documents into a clean PDF',
    availability: 'web',
    keywords: [
      'scan', 'scanner', 'document', 'camera', 'make pdf', 'new pdf', 'create pdf', 'create new pdf',
      'create document', 'new document', 'new file', 'pdf maker', 'pdf creator',
      'create pdf with camera', 'create pdf with a camera', 'document scanner', 'pdf scanner',
      'mobile scanner', 'scan document', 'scan documents', 'document scan', 'scan to pdf',
      'scan paper', 'paper to pdf', 'receipt to pdf', 'invoice to pdf', 'camera to pdf',
    ],
  },
  {
    id: 3,
    name: 'Compress PDF',
    icon: FileDown,
    iconAsset: '/tool-icons/tool_icon_compress_pdf.png',
    category: 'Optimize',
    description: 'Make the file smaller, and see how it will look first',
    color: 'slate',
    path: '/compress',
    androidTool: 'COMPRESS',
    availability: 'web',
    keywords: [
      'compress', 'compress pdf', 'compress file', 'compress large pdf', 'reduce file size',
      'reduce pdf size', 'reduce size', 'make smaller', 'shrink pdf', 'shrink file', 'smaller pdf',
      'optimize pdf', 'web optimize pdf', 'optimize for web', 'optimize file', 'reduce mb',
      'reduce filesize', 'less mb', 'file size reducer', 'resize pdf', 'small pdf',
    ],
  },
  {
    id: 4,
    name: 'Merge PDF',
    icon: FileStack,
    iconAsset: '/tool-icons/tool_icon_merge_pdf.png',
    category: 'Edit',
    description: 'Combine multiple PDFs into one',
    color: 'red',
    path: '/merge',
    androidTool: 'MERGE',
    availability: 'web',
    keywords: [
      'merge', 'merge pdf', 'combine pdf', 'combine documents', 'combine files',
      'combine multiple pdfs', 'join pdf', 'join files', 'join documents', 'append pdf',
      'pdf merger', 'single pdf', 'unified document', 'put files together', 'put pdf together',
    ],
  },
  {
    id: 5,
    name: 'Split PDF',
    icon: Scissors,
    iconAsset: '/tool-icons/tool_icon_split_pdf.png',
    category: 'Edit',
    description: 'Split one PDF into separate files',
    color: 'orange',
    path: '/split',
    androidTool: 'SPLIT',
    availability: 'web',
    keywords: [
      'split', 'split pdf', 'split pages', 'separate pdf', 'separate pages', 'break pdf',
      'split file', 'divide pdf', 'make multiple pdfs', 'split by page range', 'page range',
      'page ranges', 'pages per split',
    ],
  },
  {
    id: 6,
    name: 'Edit PDF',
    icon: Edit3,
    iconAsset: '/tool-icons/tool_icon_edit_pdf.png',
    category: 'Edit',
    description: 'Retype text, add shapes and images',
    color: 'rose',
    path: '/edit',
    androidTool: 'EDIT_PDF',
    androidTitle: 'Edit PDF (BETA)',
    androidSubtitle: 'Edit existing text, shapes, images, or add new text',
    availability: 'web',
    beta: true,
    keywords: [
      'edit', 'edit pdf', 'pdf editor', 'annotate', 'annotation', 'annotate pdf', 'pdf annotator',
      'note', 'notes', 'write on pdf', 'draw on pdf', 'highlight pdf', 'freehand annotation',
      'text boxes', 'add text boxes', 'add shapes', 'add text', 'add note', 'add notes',
      'add comment', 'add comments', 'review comments',
    ],
  },
  {
    id: 7,
    name: 'Make Fillable',
    icon: FormInput,
    iconAsset: '/tool-icons/tool_icon_make_fillable.svg',
    category: 'Edit',
    description: 'Add boxes people can type into',
    color: 'teal',
    path: '/make-fillable',
    androidTool: 'MAKE_FILLABLE',
    androidSubtitle: 'Find and check the boxes people type into',
    availability: 'web',
    keywords: [
      'make fillable', 'fillable pdf', 'create form', 'pdf form', 'form fields', 'detect form',
      'add text fields', 'add checkboxes', 'smart forms', 'interactive pdf',
    ],
  },
  {
    id: 8,
    name: 'Sign PDF',
    icon: FileSignature,
    iconAsset: '/tool-icons/tool_icon_sign_pdf.png',
    category: 'Edit',
    description: 'Draw your signature and place it on the page',
    color: 'rose',
    path: '/sign',
    androidTool: 'SIGN_PDF',
    androidSubtitle: 'Add a handwritten visible signature',
    availability: 'web',
    keywords: [
      'sign', 'sign pdf', 'signature', 'handwritten signature', 'add signature', 'sign document',
      'draw signature', 'signature stamp', 'electronic signature', 'e signature', 'e sign', 'esign',
      'fill and sign', 'fill sign', 'request signature', 'request signatures',
    ],
  },
  {
    id: 9,
    name: 'Watermark PDF',
    icon: Droplets,
    iconAsset: '/tool-icons/tool_icon_watermark_pdf.png',
    category: 'Edit',
    description: 'Stamp words like DRAFT across every page',
    color: 'red',
    path: '/watermark',
    androidTool: 'WATERMARK',
    availability: 'web',
    keywords: [
      'watermark', 'watermark pdf', 'stamp', 'stamp pdf', 'confidential', 'draft', 'approved',
      'add watermark', 'add stamp', 'text watermark', 'image watermark', 'watermark image',
      'watermark text', 'background text',
    ],
  },
  {
    id: 10,
    name: 'Protect PDF',
    icon: Lock,
    iconAsset: '/tool-icons/tool_icon_protect_pdf.png',
    category: 'Secure',
    description: 'Add a password, so it cannot be opened without one',
    color: 'slate',
    path: '/protect',
    androidTool: 'PROTECT',
    availability: 'web',
    keywords: [
      'protect', 'protect pdf', 'lock', 'lock pdf', 'password', 'password protect', 'add password',
      'secure pdf', 'pdf security', 'pdf protection', 'add pdf password', 'set password',
      'encrypt document', 'encrypt pdf', 'private pdf', 'restrict access',
    ],
  },
  {
    id: 11,
    name: 'Unlock PDF',
    icon: Unlock,
    iconAsset: '/tool-icons/tool_icon_unlock_pdf.png',
    category: 'Secure',
    description: 'Remove a password you already know',
    color: 'amber',
    path: '/unlock',
    androidTool: 'UNLOCK',
    androidSubtitle: 'Remove KNOWN password',
    availability: 'web',
    keywords: [
      'unlock', 'unlock pdf', 'remove password', 'known password', 'open locked pdf', 'decrypt pdf',
      'decrypt document', 'remove pdf password', 'remove encryption', 'remove permission',
      'remove permissions', 'password remove', 'remove known password',
    ],
  },
  {
    id: 12,
    name: 'Delete Pages',
    icon: Trash2,
    iconAsset: '/tool-icons/tool_icon_delete_pages.png',
    category: 'Edit',
    description: 'Remove the pages you select',
    color: 'red',
    path: '/delete-pages',
    androidTool: 'DELETE_PAGES',
    availability: 'web',
    keywords: [
      'page', 'pages', 'delete', 'delete pages', 'delete page', 'delete pdf pages', 'remove pages',
      'remove page', 'remove pdf pages', 'cut pages', 'drop pages', 'trim pdf',
    ],
  },
  {
    id: 13,
    name: 'Page Numbers',
    icon: Hash,
    iconAsset: '/tool-icons/tool_icon_page_numbers.png',
    category: 'Edit',
    description: 'Add page numbers, in the corner you choose',
    color: 'slate',
    path: '/page-numbers',
    androidTool: 'PAGE_NUMBERS',
    availability: 'web',
    keywords: [
      'page', 'pages', 'number', 'numbers', 'numbering', 'page numbers', 'add numbers',
      'add page number', 'add page numbers', 'add page numbers to pdf', 'insert page numbers',
      'insert page numbers in pdf', 'page numbering', 'number pages', 'footer number', 'page footer',
    ],
  },
  {
    id: 14,
    name: 'Reorder Pages',
    icon: ArrowDownUp,
    iconAsset: '/tool-icons/tool_icon_reorder_pages.png',
    category: 'Edit',
    description: 'Drag pages into a new order',
    color: 'slate',
    path: '/reorder',
    androidTool: 'REORDER_PAGES',
    availability: 'web',
    keywords: [
      'reorder', 'reorder pages', 'arrange pages', 'sort pages', 'move pages', 'change order',
      'organize pdf', 'organise pdf', 'organize pages', 'sort pdf pages', 'shuffle pages',
      'page order', 'rearrange pdf pages', 'rearrange pages',
    ],
  },
  {
    id: 15,
    name: 'Rotate Pages',
    icon: RotateCw,
    iconAsset: '/tool-icons/tool_icon_rotate_pages.png',
    category: 'Edit',
    description: 'Turn sideways or upside-down pages the right way up',
    color: 'amber',
    path: '/rotate',
    androidTool: 'ROTATE_PAGES',
    availability: 'web',
    keywords: [
      'rotate', 'rotate pages', 'turn pages', 'landscape', 'portrait', '90 degrees',
      'rotate document', 'rotate pdf', 'rotate pdf pages', 'wrong orientation', 'sideways page',
    ],
  },
  {
    id: 16,
    name: 'Flatten PDF',
    icon: Minimize2,
    iconAsset: '/tool-icons/tool_icon_flatten_pdf.png',
    category: 'Optimize',
    description: 'Lock filled answers so they cannot be changed',
    color: 'slate',
    path: '/flatten',
    androidTool: 'FLATTEN_PDF',
    androidSubtitle: 'Lock filled answers so they cannot be changed',
    availability: 'web',
    keywords: [
      'flatten', 'flatten pdf', 'flatten form', 'flatten forms', 'form fields', 'filled form',
      'fill form', 'bake fields', 'make fields permanent', 'lock form fields',
      'make pdf uneditable', 'uneditable pdf', 'flatten annotations',
    ],
  },
  {
    id: 17,
    name: 'Extract Pages',
    icon: FileText,
    iconAsset: '/tool-icons/tool_icon_extract_pages.png',
    category: 'Edit',
    description: 'Save the pages you pick as a new PDF',
    color: 'amber',
    path: '/extract',
    androidTool: 'EXTRACT_PAGES',
    availability: 'web',
    keywords: [
      'page', 'pages', 'extract', 'extract pages', 'extract page', 'extract selected pages',
      'pick pages', 'pull pages', 'take pages', 'save pages', 'save one page', 'copy pages',
      'duplicate pages',
    ],
  },
  {
    id: 18,
    name: 'Image to PDF',
    icon: ImageIcon,
    iconAsset: '/tool-icons/tool_icon_image_to_pdf.png',
    category: 'Convert',
    description: 'Build a PDF from photos and images',
    color: 'teal',
    path: '/image-to-pdf',
    androidTool: 'JPG_TO_PDF',
    availability: 'web',
    keywords: [
      'image', 'images', 'jpg', 'jpeg', 'png', 'bmp', 'gif', 'tif', 'tiff', 'webp', 'heic',
      'photo', 'photos', 'picture', 'pictures', 'image to pdf', 'images to pdf',
      'image files to pdf', 'jpg to pdf', 'jpeg to pdf', 'png to pdf', 'bmp to pdf', 'gif to pdf',
      'tiff to pdf', 'webp to pdf', 'heic to pdf', 'photo to pdf', 'photos to pdf',
      'picture to pdf', 'pictures to pdf', 'create pdf from image', 'create pdf from images',
      'create pdf from photo', 'create pdf from photos', 'make pdf from image',
      'make pdf from images', 'make pdf from photo', 'make pdf from photos', 'convert image to pdf',
      'convert images to pdf',
    ],
  },
  {
    id: 19,
    name: 'PDF to Image',
    icon: FileImage,
    iconAsset: '/tool-icons/tool_icon_pdf_to_image.png',
    category: 'Convert',
    description: 'Save each page as a picture you can share',
    color: 'emerald',
    path: '/pdf-to-jpg',
    androidTool: 'PDF_TO_JPG',
    availability: 'web',
    keywords: [
      'page', 'pages', 'image', 'images', 'jpg', 'jpeg', 'png', 'pdf to jpg', 'pdf to jpeg',
      'pdf to image', 'pdf to images', 'export image', 'export pages as images', 'convert to image',
      'convert pdf to image', 'convert pdf to jpg', 'convert pdf to png', 'extract images',
      'extract pdf images', 'save page as image', 'save pages as images', 'pdf pages to images',
    ],
  },
  {
    id: 20,
    name: 'PDF to Word',
    icon: FileType2,
    iconAsset: '/tool-icons/tool_icon_pdf_to_word.png',
    category: 'Convert',
    description: 'Turn the text into an editable Word file',
    color: 'teal',
    path: '/pdf-to-word',
    androidTool: 'PDF_TO_DOC',
    androidTitle: 'PDF to Word (BETA)',
    androidSubtitle: 'Turn the text into an editable Word file',
    availability: 'web',
    beta: true,
    keywords: [
      'doc', 'docs', 'docx', 'word', 'microsoft word', 'word document', 'pdf to doc',
      'pdf to docs', 'pdf to docx', 'pdf to word', 'convert pdf to docx', 'convert to word',
      'convert pdf to word', 'export word', 'text to word', 'word file',
    ],
  },
  {
    id: 32,
    name: 'Word to PDF',
    icon: FileOutput,
    iconAsset: '/tool-icons/tool_icon_word_to_pdf.png',
    category: 'Convert',
    description: 'Turn a Word file into a PDF (text only)',
    color: 'blue',
    path: '/word-to-pdf',
    androidTool: 'DOC_TO_PDF',
    androidTitle: 'Word to PDF (BETA)',
    androidSubtitle: 'Text only, and .docx files only',
    availability: 'web',
    beta: true,
    keywords: ['word to pdf', 'docx to pdf', 'convert word', 'convert docx', 'word document to pdf', 'office to pdf'],
  },
  {
    id: 33,
    name: 'PowerPoint to PDF',
    icon: Presentation,
    iconAsset: '/tool-icons/tool_icon_powerpoint_to_pdf.png',
    category: 'Convert',
    description: 'Turn slides into a PDF, same shape',
    color: 'orange',
    path: '/powerpoint-to-pdf',
    androidTool: 'PPTX_TO_PDF',
    androidTitle: 'PowerPoint to PDF (BETA)',
    androidSubtitle: '.pptx slides only; review font substitutions',
    availability: 'web',
    beta: true,
    keywords: ['powerpoint to pdf', 'pptx to pdf', 'slides to pdf', 'presentation to pdf', 'convert pptx', 'office slides'],
  },
  {
    id: 21,
    name: 'Extract Text',
    icon: FileText,
    iconAsset: '/tool-icons/tool_icon_extract_text.png',
    category: 'Convert',
    // Android exports the embedded text layer only; this build adds Tesseract OCR for scans.
    description: 'Copy out the words, even from a scan',
    color: 'teal',
    path: '/ocr',
    androidTool: 'OCR_TEXT',
    androidSubtitle: 'Copy out the words this PDF already carries',
    availability: 'web',
    keywords: [
      'text', 'extract text', 'searchable text', 'read text', 'ocr', 'ocr pdf', 'pdf ocr',
      'scan text', 'copy text', 'text file', 'get text', 'pull text', 'pdf to text', 'pdf to txt',
      'convert pdf to text', 'extract text from pdf', 'text recognition', 'recognize text',
      'pdf text',
    ],
  },
  {
    id: 22,
    name: 'Document Info',
    icon: Database,
    iconAsset: '/tool-icons/tool_icon_metadata.png',
    category: 'Secure',
    description: 'See and change the title, author and dates',
    color: 'slate',
    path: '/metadata',
    androidTool: 'METADATA',
    availability: 'web',
    keywords: [
      'metadata', 'properties', 'document info', 'author', 'title', 'keywords', 'producer',
      'edit title', 'edit author', 'change title', 'change author', 'document information',
      'change document information', 'change pdf document information', 'remove metadata',
      'remove pdf metadata', 'clear metadata', 'pdf info', 'pdf information', 'pdf properties',
    ],
  },
  {
    id: 23,
    name: 'Repair PDF',
    icon: Wrench,
    iconAsset: '/tool-icons/tool_icon_repair_pdf.png',
    category: 'Optimize',
    description: 'Re-save a PDF that will not open properly elsewhere',
    color: 'orange',
    path: '/repair',
    androidTool: 'REPAIR_PDF',
    androidSubtitle: 'Re-save readable PDFs to fix minor issues',
    availability: 'web',
    keywords: [
      'repair', 'repair pdf', 'fix pdf', 'broken pdf', 'recover pdf', 'open issue', 'compatibility',
      'corrupt pdf', 'damaged pdf', 'repair damaged pdf', 'recover corrupt pdf', 'fix pdf files',
      'pdf not opening',
    ],
  },
  {
    id: 24,
    name: 'Compare Summary',
    icon: GitCompare,
    iconAsset: '/tool-icons/tool_icon_compare_summary.png',
    category: 'Optimize',
    description: 'See which pages have different wording',
    color: 'lime',
    path: '/compare',
    androidTool: 'COMPARE_PDF',
    androidSubtitle: 'Compare two PDFs and export a basic summary',
    availability: 'web',
    keywords: [
      'compare', 'compare pdf', 'compare summary', 'difference', 'diff', 'changes', 'two pdfs',
      'compare files', 'compare documents', 'document compare', 'compare pdfs', 'check changes',
      'pdf difference', 'diff pdf',
    ],
  },
  {
    id: 25,
    name: 'Crop',
    icon: Crop,
    category: 'Edit',
    description: 'Trim the white space around the edges',
    color: 'cyan',
    path: '/crop',
    availability: 'web',
    keywords: ['crop', 'crop pdf', 'trim margins', 'trim page', 'margins', 'crop box'],
  },
  {
    id: 26,
    name: 'Header & Footer',
    icon: Heading,
    category: 'Edit',
    description: 'Put the same line at the top or bottom of every page',
    color: 'blue',
    path: '/header-footer',
    availability: 'web',
    keywords: ['header', 'footer', 'header and footer', 'running head', 'repeated text', 'label pages'],
  },
  {
    id: 27,
    name: 'Extract images',
    icon: FileImage,
    category: 'Convert',
    description: 'Save the pictures stored inside a PDF',
    color: 'cyan',
    path: '/extract-images',
    availability: 'web',
    keywords: ['extract images', 'embedded images', 'save images', 'pull images', 'images from pdf'],
  },
  {
    id: 28,
    name: 'Remove hidden info',
    icon: ShieldOff,
    category: 'Secure',
    description: 'Clear the author, dates and app names',
    color: 'emerald',
    path: '/remove-metadata',
    availability: 'web',
    keywords: ['remove metadata', 'clear metadata', 'strip metadata', 'hidden info', 'remove hidden info', 'anonymize pdf'],
  },
  {
    id: 29,
    name: 'Remove comments',
    icon: StickyNote,
    category: 'Secure',
    description: 'Remove comments, notes and highlights',
    color: 'red',
    path: '/remove-annotations',
    availability: 'web',
    keywords: ['remove annotations', 'remove comments', 'annotations', 'strip markup', 'clear highlights', 'delete notes'],
  },
  {
    id: 30,
    name: 'Clean Up',
    icon: ShieldOff,
    category: 'Secure',
    description: 'Remove hidden info and comments together',
    color: 'violet',
    path: '/sanitize',
    availability: 'web',
    keywords: ['sanitize', 'clean up', 'clean pdf', 'scrub pdf', 'hidden data', 'redact metadata'],
  },
  {
    id: 31,
    name: 'Remove blank pages',
    icon: ScanSearch,
    category: 'Optimize',
    description: 'Find and remove pages with nothing on them',
    color: 'purple',
    path: '/remove-blank-pages',
    availability: 'web',
    keywords: ['blank pages', 'remove blank pages', 'empty pages', 'delete blank', 'clean pages'],
  },
  {
    id: 34,
    name: 'Batch Processing',
    icon: FileStack,
    category: 'Optimize',
    description: 'Do the same job to several PDFs at once',
    color: 'violet',
    path: '/batch',
    availability: 'web',
    keywords: ['batch', 'bulk', 'multiple pdfs', 'process many files', 'batch processing', 'bulk pdf tools'],
  },
  {
    id: 35,
    name: 'Invoice',
    icon: Banknote,
    category: 'Create',
    description: 'Make an invoice and get paid',
    color: 'emerald',
    path: '/invoice',
    availability: 'web',
    keywords: [
      'invoice', 'make invoice', 'create invoice', 'invoice maker', 'invoice generator',
      'bill', 'billing', 'make a bill', 'send an invoice', 'freelance invoice',
      'invoice template', 'tax invoice', 'vat invoice', 'gst invoice', 'get paid',
    ],
  },
  {
    id: 36,
    name: 'Receipt',
    icon: Receipt,
    category: 'Create',
    description: 'Give someone proof they paid',
    color: 'blue',
    path: '/receipt',
    availability: 'web',
    keywords: [
      'receipt', 'make receipt', 'create receipt', 'receipt maker', 'receipt generator',
      'proof of payment', 'payment received', 'paid', 'rent receipt', 'cash receipt',
      'receipt template', 'sales receipt', 'donation receipt',
    ],
  },
  {
    id: 37,
    name: 'Quote',
    icon: HandCoins,
    category: 'Create',
    description: 'Tell someone what a job will cost',
    color: 'amber',
    path: '/quote',
    availability: 'web',
    keywords: [
      'quote', 'quotation', 'make quote', 'create quote', 'quote maker', 'estimate',
      'estimate maker', 'price quote', 'proposal', 'bid', 'costing', 'quote template',
      'job quote', 'builder quote',
    ],
  },
];

/**
 * Matches the Android home screen filter strip (`HomeCategory` in `ui/app/AppHomeScreen.kt`),
 * with Create leading it: making a document from nothing is the one job here
 * that does not start with a file you already have.
 */
export const categoryOrder: ('All' | ToolCategory)[] =
  ['All', 'Create', 'Edit', 'Optimize', 'Convert', 'Secure'];
