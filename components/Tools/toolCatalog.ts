import { t } from '../../services/i18n/core.ts';
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
  ShieldCheck,
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
 * `native-only` has no browser-side implementation; the route stays live and says so.
 */
export type ToolAvailability = 'web' | 'native-only';

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
    get name() { return t("tool-catalog.view.pdf.546f08"); },
    icon: Eye,
    iconAsset: '/tool-icons/tool_icon_read_pdf.svg',
    category: 'Edit',
    get description() { return t("tool-catalog.open.a.pdf.and.send.it.to.68b302"); },
    color: 'blue',
    path: '/view',
    androidTool: 'READER',
    availability: 'web',
    keywords: ['view', 'open', 'read', 'reader', 'preview', 'viewer', 'open pdf', 'read pdf'],
  },
  {
    id: 2,
    get name() { return t("tool-catalog.create.pdf.e45411"); },
    icon: Smartphone,
    iconAsset: '/tool-icons/tool_icon_create_pdf.png',
    category: 'Convert',
    // Android drives the ML Kit document scanner; the browser has camera capture and file pick.
    get description() { return t("tool-catalog.capture.or.import.photos.into.a.clean.495ae8"); },
    color: 'red',
    path: '/make-pdf',
    androidTool: 'MAKE_PDF',
    get androidSubtitle() { return t("tool-catalog.scan.paper.documents.into.a.clean.pdf.16f23c"); },
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
    get name() { return t("tool-catalog.compress.pdf.932c3c"); },
    icon: FileDown,
    iconAsset: '/tool-icons/tool_icon_compress_pdf.png',
    category: 'Optimize',
    get description() { return t("tool-catalog.make.the.file.smaller.and.see.how.3eb6d6"); },
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
    get name() { return t("tool-catalog.merge.pdf.566bfc"); },
    icon: FileStack,
    iconAsset: '/tool-icons/tool_icon_merge_pdf.png',
    category: 'Edit',
    get description() { return t("tool-catalog.combine.multiple.pdfs.into.one.7e66b8"); },
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
    get name() { return t("tool-catalog.split.pdf.4f1b84"); },
    icon: Scissors,
    iconAsset: '/tool-icons/tool_icon_split_pdf.png',
    category: 'Edit',
    get description() { return t("tool-catalog.split.one.pdf.into.separate.files.78fa0c"); },
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
    get name() { return t("tool-catalog.edit.pdf.0e484d"); },
    icon: Edit3,
    iconAsset: '/tool-icons/tool_icon_edit_pdf.png',
    category: 'Edit',
    get description() { return t("tool-catalog.retype.text.add.shapes.and.images.39d7b7"); },
    color: 'rose',
    path: '/edit',
    androidTool: 'EDIT_PDF',
    get androidTitle() { return t("tool-catalog.edit.pdf.beta.7928fb"); },
    get androidSubtitle() { return t("tool-catalog.edit.existing.text.shapes.images.or.add.b3931f"); },
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
    get name() { return t("tool-catalog.make.fillable.c63556"); },
    icon: FormInput,
    iconAsset: '/tool-icons/tool_icon_make_fillable.svg',
    category: 'Edit',
    get description() { return t("tool-catalog.add.boxes.people.can.type.into.71b464"); },
    color: 'teal',
    path: '/make-fillable',
    androidTool: 'MAKE_FILLABLE',
    get androidSubtitle() { return t("tool-catalog.find.and.check.the.boxes.people.type.7b1a7b"); },
    availability: 'web',
    keywords: [
      'make fillable', 'fillable pdf', 'create form', 'pdf form', 'form fields', 'detect form',
      'add text fields', 'add checkboxes', 'smart forms', 'interactive pdf',
    ],
  },
  {
    id: 8,
    get name() { return t("tool-catalog.sign.pdf.1bf93e"); },
    icon: FileSignature,
    iconAsset: '/tool-icons/tool_icon_sign_pdf.png',
    category: 'Edit',
    get description() { return t("tool-catalog.draw.your.signature.and.place.it.on.892842"); },
    color: 'rose',
    path: '/sign',
    androidTool: 'SIGN_PDF',
    get androidSubtitle() { return t("tool-catalog.add.a.handwritten.visible.signature.501a56"); },
    availability: 'web',
    keywords: [
      'sign', 'sign pdf', 'signature', 'handwritten signature', 'add signature', 'sign document',
      'draw signature', 'signature stamp', 'electronic signature', 'e signature', 'e sign', 'esign',
      'fill and sign', 'fill sign', 'request signature', 'request signatures',
    ],
  },
  {
    id: 38,
    get name() { return t("view-pdf.verify.pdf.signatures.93bd01"); },
    icon: ShieldCheck,
    iconAsset: '/tool-icons/tool_icon_verify_signatures.svg',
    category: 'Secure',
    description: '',
    color: 'green',
    path: '/verify-signatures',
    availability: 'native-only',
    keywords: [
      'verify signature', 'verify signatures', 'digital signature', 'digital signatures',
      'certificate', 'certificate verification', 'aadhaar signature', 'gst signature',
      'signed pdf', 'signature validity', 'check signature',
    ],
  },
  {
    id: 9,
    get name() { return t("tool-catalog.watermark.pdf.903ce9"); },
    icon: Droplets,
    iconAsset: '/tool-icons/tool_icon_watermark_pdf.png',
    category: 'Edit',
    get description() { return t("tool-catalog.stamp.words.like.draft.across.every.page.827475"); },
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
    get name() { return t("tool-catalog.protect.pdf.dae6c6"); },
    icon: Lock,
    iconAsset: '/tool-icons/tool_icon_protect_pdf.png',
    category: 'Secure',
    get description() { return t("tool-catalog.add.a.password.so.it.cannot.be.7e696a"); },
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
    get name() { return t("tool-catalog.unlock.pdf.893947"); },
    icon: Unlock,
    iconAsset: '/tool-icons/tool_icon_unlock_pdf.png',
    category: 'Secure',
    get description() { return t("tool-catalog.remove.a.password.you.already.know.cfff3b"); },
    color: 'amber',
    path: '/unlock',
    androidTool: 'UNLOCK',
    get androidSubtitle() { return t("tool-catalog.remove.known.password.6017fb"); },
    availability: 'web',
    keywords: [
      'unlock', 'unlock pdf', 'remove password', 'known password', 'open locked pdf', 'decrypt pdf',
      'decrypt document', 'remove pdf password', 'remove encryption', 'remove permission',
      'remove permissions', 'password remove', 'remove known password',
    ],
  },
  {
    id: 12,
    get name() { return t("tool-catalog.delete.pages.7c7be5"); },
    icon: Trash2,
    iconAsset: '/tool-icons/tool_icon_delete_pages.png',
    category: 'Edit',
    get description() { return t("tool-catalog.remove.the.pages.you.select.b3a8f0"); },
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
    get name() { return t("tool-catalog.page.numbers.78c8fa"); },
    icon: Hash,
    iconAsset: '/tool-icons/tool_icon_page_numbers.png',
    category: 'Edit',
    get description() { return t("tool-catalog.add.page.numbers.in.the.corner.you.0fdd6f"); },
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
    get name() { return t("tool-catalog.reorder.pages.522c7c"); },
    icon: ArrowDownUp,
    iconAsset: '/tool-icons/tool_icon_reorder_pages.png',
    category: 'Edit',
    get description() { return t("tool-catalog.drag.pages.into.a.new.order.a00891"); },
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
    get name() { return t("tool-catalog.rotate.pages.0cbe65"); },
    icon: RotateCw,
    iconAsset: '/tool-icons/tool_icon_rotate_pages.png',
    category: 'Edit',
    get description() { return t("tool-catalog.turn.sideways.or.upside.down.pages.the.9fc937"); },
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
    get name() { return t("tool-catalog.flatten.pdf.86c838"); },
    icon: Minimize2,
    iconAsset: '/tool-icons/tool_icon_flatten_pdf.png',
    category: 'Optimize',
    get description() { return t("tool-catalog.lock.filled.answers.so.they.cannot.be.939eee"); },
    color: 'slate',
    path: '/flatten',
    androidTool: 'FLATTEN_PDF',
    get androidSubtitle() { return t("tool-catalog.lock.filled.answers.so.they.cannot.be.939eee"); },
    availability: 'web',
    keywords: [
      'flatten', 'flatten pdf', 'flatten form', 'flatten forms', 'form fields', 'filled form',
      'fill form', 'bake fields', 'make fields permanent', 'lock form fields',
      'make pdf uneditable', 'uneditable pdf', 'flatten annotations',
    ],
  },
  {
    id: 17,
    get name() { return t("tool-catalog.extract.pages.1ea574"); },
    icon: FileText,
    iconAsset: '/tool-icons/tool_icon_extract_pages.png',
    category: 'Edit',
    get description() { return t("tool-catalog.save.the.pages.you.pick.as.a.7b7f45"); },
    color: 'amber',
    path: '/extract',
    androidTool: 'EXTRACT_PAGES',
    availability: 'web',
    keywords: [
      'page', 'pages', 'extract', 'extract pages', 'extract page', 'extract selected pages',
      'pick pages', 'pull pages', 'take pages', 'save pages', 'save one page', 'copy pages',
      'duplicate pages', 'page range', 'extract page range', 'save page range',
      'save selected pages', 'pages as one pdf', 'select pages',
    ],
  },
  {
    id: 18,
    get name() { return t("tool-catalog.image.to.pdf.966eba"); },
    icon: ImageIcon,
    iconAsset: '/tool-icons/tool_icon_image_to_pdf.png',
    category: 'Convert',
    get description() { return t("tool-catalog.build.a.pdf.from.photos.and.images.edb5e1"); },
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
    get name() { return t("tool-catalog.pdf.to.image.185e0a"); },
    icon: FileImage,
    iconAsset: '/tool-icons/tool_icon_pdf_to_image.png',
    category: 'Convert',
    get description() { return t("tool-catalog.save.each.page.as.a.picture.you.ef3b53"); },
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
    get name() { return t("tool-catalog.pdf.to.word.283553"); },
    icon: FileType2,
    iconAsset: '/tool-icons/tool_icon_pdf_to_word.png',
    category: 'Convert',
    get description() { return t("tool-catalog.turn.the.text.into.an.editable.word.002e78"); },
    color: 'teal',
    path: '/pdf-to-word',
    androidTool: 'PDF_TO_DOC',
    get androidTitle() { return t("tool-catalog.pdf.to.word.beta.251e21"); },
    get androidSubtitle() { return t("tool-catalog.turn.the.text.into.an.editable.word.002e78"); },
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
    get name() { return t("tool-catalog.word.to.pdf.e6cb11"); },
    icon: FileOutput,
    iconAsset: '/tool-icons/tool_icon_word_to_pdf.png',
    category: 'Convert',
    get description() { return t("tool-catalog.turn.a.word.file.into.a.pdf.b17bc1"); },
    color: 'blue',
    path: '/word-to-pdf',
    androidTool: 'DOC_TO_PDF',
    get androidTitle() { return t("tool-catalog.word.to.pdf.beta.841d23"); },
    get androidSubtitle() { return t("tool-catalog.text.only.and.docx.files.only.3f3c4e"); },
    availability: 'web',
    beta: true,
    keywords: ['word to pdf', 'docx to pdf', 'convert word', 'convert docx', 'word document to pdf', 'office to pdf'],
  },
  {
    id: 33,
    get name() { return t("tool-catalog.powerpoint.to.pdf.799dd2"); },
    icon: Presentation,
    iconAsset: '/tool-icons/tool_icon_powerpoint_to_pdf.png',
    category: 'Convert',
    get description() { return t("tool-catalog.turn.slides.into.a.pdf.same.shape.ec019b"); },
    color: 'orange',
    path: '/powerpoint-to-pdf',
    androidTool: 'PPTX_TO_PDF',
    get androidTitle() { return t("tool-catalog.powerpoint.to.pdf.beta.09b5e3"); },
    get androidSubtitle() { return t("tool-catalog.pptx.slides.only.review.font.substitutions.87078d"); },
    availability: 'web',
    beta: true,
    keywords: ['powerpoint to pdf', 'pptx to pdf', 'slides to pdf', 'presentation to pdf', 'convert pptx', 'office slides'],
  },
  {
    id: 21,
    get name() { return t("tool-catalog.extract.text.9ab592"); },
    icon: FileText,
    iconAsset: '/tool-icons/tool_icon_extract_text.png',
    category: 'Convert',
    // Android exports the embedded text layer only; this build adds Tesseract OCR for scans.
    get description() { return t("tool-catalog.copy.out.the.words.even.from.a.9a5be6"); },
    color: 'teal',
    path: '/ocr',
    androidTool: 'OCR_TEXT',
    get androidSubtitle() { return t("tool-catalog.copy.out.the.words.this.pdf.already.aabe38"); },
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
    get name() { return t("tool-catalog.document.info.758cc7"); },
    icon: Database,
    iconAsset: '/tool-icons/tool_icon_metadata.png',
    category: 'Secure',
    get description() { return t("tool-catalog.see.and.change.the.title.author.and.39922b"); },
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
    get name() { return t("tool-catalog.repair.pdf.43faa0"); },
    icon: Wrench,
    iconAsset: '/tool-icons/tool_icon_repair_pdf.png',
    category: 'Optimize',
    get description() { return t("tool-catalog.re.save.a.pdf.that.will.not.033a59"); },
    color: 'orange',
    path: '/repair',
    androidTool: 'REPAIR_PDF',
    get androidSubtitle() { return t("tool-catalog.re.save.readable.pdfs.to.fix.minor.bf8013"); },
    availability: 'web',
    keywords: [
      'repair', 'repair pdf', 'fix pdf', 'broken pdf', 'recover pdf', 'open issue', 'compatibility',
      'corrupt pdf', 'damaged pdf', 'repair damaged pdf', 'recover corrupt pdf', 'fix pdf files',
      'pdf not opening',
    ],
  },
  {
    id: 24,
    get name() { return t("tool-catalog.compare.summary.62ec42"); },
    icon: GitCompare,
    iconAsset: '/tool-icons/tool_icon_compare_summary.png',
    category: 'Optimize',
    get description() { return t("tool-catalog.see.which.pages.have.different.wording.febd15"); },
    color: 'lime',
    path: '/compare',
    androidTool: 'COMPARE_PDF',
    get androidSubtitle() { return t("tool-catalog.compare.two.pdfs.and.export.a.basic.6ebe40"); },
    availability: 'web',
    keywords: [
      'compare', 'compare pdf', 'compare summary', 'difference', 'diff', 'changes', 'two pdfs',
      'compare files', 'compare documents', 'document compare', 'compare pdfs', 'check changes',
      'pdf difference', 'diff pdf',
    ],
  },
  {
    id: 25,
    get name() { return t("tool-catalog.crop.98caf7"); },
    icon: Crop,
    iconAsset: '/tool-icons/tool_icon_crop.svg',
    category: 'Edit',
    get description() { return t("tool-catalog.trim.the.white.space.around.the.edges.06278e"); },
    color: 'cyan',
    path: '/crop',
    availability: 'web',
    keywords: ['crop', 'crop pdf', 'trim margins', 'trim page', 'margins', 'crop box'],
  },
  {
    id: 26,
    get name() { return t("tool-catalog.header.footer.aaf783"); },
    icon: Heading,
    iconAsset: '/tool-icons/tool_icon_header_footer.svg',
    category: 'Edit',
    get description() { return t("tool-catalog.put.the.same.line.at.the.top.d4b98f"); },
    color: 'blue',
    path: '/header-footer',
    availability: 'web',
    keywords: ['header', 'footer', 'header and footer', 'running head', 'repeated text', 'label pages'],
  },
  {
    id: 27,
    get name() { return t("tool-catalog.extract.images.b210c0"); },
    icon: FileImage,
    iconAsset: '/tool-icons/tool_icon_extract_images.svg',
    category: 'Convert',
    get description() { return t("tool-catalog.save.the.pictures.stored.inside.a.pdf.abff4c"); },
    color: 'cyan',
    path: '/extract-images',
    availability: 'web',
    keywords: ['extract images', 'embedded images', 'save images', 'pull images', 'images from pdf'],
  },
  {
    id: 28,
    get name() { return t("tool-catalog.remove.hidden.info.fa4793"); },
    icon: ShieldOff,
    iconAsset: '/tool-icons/tool_icon_remove_metadata.svg',
    category: 'Secure',
    get description() { return t("tool-catalog.clear.the.author.dates.and.app.names.841e6b"); },
    color: 'emerald',
    path: '/remove-metadata',
    availability: 'web',
    keywords: ['remove metadata', 'clear metadata', 'strip metadata', 'hidden info', 'remove hidden info', 'anonymize pdf'],
  },
  {
    id: 29,
    get name() { return t("tool-catalog.remove.comments.0788e6"); },
    icon: StickyNote,
    iconAsset: '/tool-icons/tool_icon_remove_annotations.svg',
    category: 'Secure',
    get description() { return t("tool-catalog.remove.comments.notes.and.highlights.7f35fe"); },
    color: 'red',
    path: '/remove-annotations',
    availability: 'web',
    keywords: ['remove annotations', 'remove comments', 'annotations', 'strip markup', 'clear highlights', 'delete notes'],
  },
  {
    id: 30,
    get name() { return t("tool-catalog.clean.up.650917"); },
    icon: ShieldOff,
    iconAsset: '/tool-icons/tool_icon_sanitize.svg',
    category: 'Secure',
    get description() { return t("tool-catalog.remove.hidden.info.and.comments.together.228b0b"); },
    color: 'violet',
    path: '/sanitize',
    availability: 'web',
    keywords: ['sanitize', 'clean up', 'clean pdf', 'scrub pdf', 'hidden data', 'redact metadata'],
  },
  {
    id: 31,
    get name() { return t("tool-catalog.remove.blank.pages.527c64"); },
    icon: ScanSearch,
    iconAsset: '/tool-icons/tool_icon_remove_blank_pages.svg',
    category: 'Optimize',
    get description() { return t("tool-catalog.find.and.remove.pages.with.nothing.on.b3a678"); },
    color: 'purple',
    path: '/remove-blank-pages',
    availability: 'web',
    keywords: ['blank pages', 'remove blank pages', 'empty pages', 'delete blank', 'clean pages'],
  },
  {
    id: 34,
    get name() { return t("tool-catalog.batch.processing.36bf5b"); },
    icon: FileStack,
    iconAsset: '/tool-icons/tool_icon_batch.svg',
    category: 'Optimize',
    get description() { return t("tool-catalog.do.the.same.job.to.several.pdfs.57b240"); },
    color: 'violet',
    path: '/batch',
    availability: 'web',
    keywords: ['batch', 'bulk', 'multiple pdfs', 'process many files', 'batch processing', 'bulk pdf tools'],
  },
  {
    id: 35,
    get name() { return t("tool-catalog.invoice.b83200"); },
    icon: Banknote,
    iconAsset: '/tool-icons/tool_icon_invoice.svg',
    category: 'Create',
    get description() { return t("tool-catalog.make.an.invoice.and.get.paid.245983"); },
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
    get name() { return t("tool-catalog.receipt.dad5a9"); },
    icon: Receipt,
    iconAsset: '/tool-icons/tool_icon_receipt.svg',
    category: 'Create',
    get description() { return t("tool-catalog.give.someone.proof.they.paid.3c2589"); },
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
    get name() { return t("tool-catalog.quote.eb4cde"); },
    icon: HandCoins,
    iconAsset: '/tool-icons/tool_icon_quote.svg',
    category: 'Create',
    get description() { return t("tool-catalog.tell.someone.what.a.job.will.cost.12adae"); },
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
