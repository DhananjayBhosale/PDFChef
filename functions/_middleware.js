const ORIGIN = "https://pdfchef.dhananjaytech.app";
const WEB_ANALYTICS_SCRIPT_ORIGIN = "https://static.cloudflareinsights.com";
const WEB_ANALYTICS_CONNECT_ORIGIN = "https://cloudflareinsights.com";

const defaultMeta = {
  title: "PDF Chef - Private PDF Tools",
  description: "Private PDF tools that run in your browser. Merge, split, convert, edit, secure, and optimize PDFs locally.",
};

const routeMeta = {
  "/": defaultMeta,
  "/view": {
    title: "View PDF Online | PDF Chef",
    description: "Open and view PDFs privately in PDF Chef, then send the current file into editing, signing, compression, and other tools.",
  },
  "/compress": {
    title: "Compress PDF - Reduce File Size Online | PDF Chef",
    description: "Reduce PDF size with browser-based compression and readability preview controls. Private and client-side.",
  },
  "/merge": {
    title: "Merge PDF Files Online - Free & Private | PDF Chef",
    description: "Combine multiple PDFs into one document instantly with local processing. No upload required.",
  },
  "/split": {
    title: "Split PDF Pages - Extract & Separate Online | PDF Chef",
    description: "Split PDFs by selected pages, all pages, or by custom page groups, fully in-browser.",
  },
  "/edit": {
    title: "Edit PDF - Fill Form Fields and Add Text | PDF Chef",
    description: "Fill detected PDF form fields or place text overlays on a page, then save the updated document privately on your device.",
  },
  "/pdf-to-jpg": {
    title: "PDF to JPG Converter - Export Pages to Images | PDF Chef",
    description: "Convert PDF pages to JPG, PNG, or WebP images with live quality and DPI controls.",
  },
  "/pdf-to-word": {
    title: "PDF to Word - Export PDF Text to DOCX | PDF Chef",
    description: "Convert the searchable text layer of a PDF into a .docx file in your browser. No upload, no account.",
  },
  "/word-to-pdf": {
    title: "Word to PDF - Convert DOCX Locally | PDF Chef",
    description: "Convert text from .docx Word files into PDF pages entirely in your browser. No upload or account.",
  },
  "/powerpoint-to-pdf": {
    title: "PowerPoint to PDF - Convert PPTX Locally | PDF Chef",
    description: "Render .pptx slides to PDF at their native aspect ratio with local browser processing.",
  },
  "/make-fillable": {
    title: "Make PDF Fillable - Form Field Detection | PDF Chef",
    description: "Suggest, draw, review, and export real fillable PDF fields locally in your browser.",
  },
  "/image-to-pdf": {
    title: "JPG to PDF Converter - Create PDFs from Images | PDF Chef",
    description: "Create PDFs from images with drag-and-drop layout controls and local export.",
  },
  "/make-pdf": {
    title: "Create PDF from Photos - Camera or Gallery | PDF Chef",
    description: "Capture or import photos and build a scanned PDF directly in your browser.",
  },
  "/sign": {
    title: "Sign PDF - Add Signature Image | PDF Chef",
    description: "Draw or upload your signature, place it on pages, and export a signed PDF locally.",
  },
  "/delete-pages": {
    title: "Delete PDF Pages - Remove Unwanted Pages | PDF Chef",
    description: "Select and remove PDF pages visually with thumbnail previews and instant export.",
  },
  "/reorder": {
    title: "Reorder PDF Pages - Drag and Drop Sort | PDF Chef",
    description: "Rearrange PDF pages with drag-and-drop ordering and page-level previews.",
  },
  "/rotate": {
    title: "Rotate PDF Pages - Batch Page Rotation | PDF Chef",
    description: "Rotate selected or all PDF pages by 90-degree increments and download the updated file.",
  },
  "/protect": {
    title: "Protect PDF with Password | PDF Chef",
    description: "Encrypt PDF documents with a password locally and keep your files private.",
  },
  "/unlock": {
    title: "Unlock PDF - Remove Password | PDF Chef",
    description: "Decrypt password-protected PDFs locally after entering the correct password.",
  },
  "/extract": {
    title: "Extract PDF Pages - Export Selected Pages | PDF Chef",
    description: "Choose exact pages and export them into a new PDF file with local-only processing.",
  },
  "/metadata": {
    title: "PDF Metadata Editor - Title, Author, Keywords | PDF Chef",
    description: "View and update PDF metadata fields like title, author, subject, and keywords.",
  },
  "/flatten": {
    title: "Flatten PDF Forms - Lock Form Fields | PDF Chef",
    description: "Flatten form fields into static content to make documents non-editable.",
  },
  "/compare": {
    title: "Compare PDF Files - Multi-page Comparison Report | PDF Chef",
    description: "Compare two PDFs page by page and export a detailed text comparison report.",
  },
  "/ocr": {
    title: "OCR PDF - Extract Text Layer or Run OCR | PDF Chef",
    description: "Extract text from PDF text layers or run OCR on image-based pages directly in-browser.",
  },
  "/watermark": {
    title: "Watermark PDF - Add Custom Text Watermark | PDF Chef",
    description: "Apply text watermarks with custom size, opacity, color, and rotation.",
  },
  "/page-numbers": {
    title: "Add Page Numbers to PDF | PDF Chef",
    description: "Add custom page numbering with flexible format, position, and page range controls.",
  },
  "/repair": {
    title: "Repair PDF - Re-save for Compatibility | PDF Chef",
    description: "Rebuild and re-save PDFs to improve compatibility with strict PDF readers.",
  },
  "/crop": {
    title: "Crop PDF - Trim Page Margins | PDF Chef",
    description: "Crop PDF page margins privately in your browser by applying a new crop box.",
  },
  "/header-footer": {
    title: "Add Header and Footer to PDF | PDF Chef",
    description: "Add repeated header and footer text with page numbering tokens directly in your browser.",
  },
  "/remove-metadata": {
    title: "Remove PDF Metadata | PDF Chef",
    description: "Strip title, author, dates, viewer preferences, and hidden metadata from PDFs locally.",
  },
  "/remove-annotations": {
    title: "Remove PDF Annotations | PDF Chef",
    description: "Remove comments, annotations, markup, and page-level actions from PDF files without uploading.",
  },
  "/remove-blank-pages": {
    title: "Remove Blank Pages from PDF | PDF Chef",
    description: "Detect mostly empty PDF pages and export a cleaned copy with local processing.",
  },
  "/extract-images": {
    title: "Extract Images from PDF | PDF Chef",
    description: "Find embedded images in PDF files and download them as PNG files in a ZIP archive.",
  },
  "/sanitize": {
    title: "Sanitize PDF - Clean Hidden Data | PDF Chef",
    description: "Clean metadata and annotations from PDFs in one privacy-focused browser pass.",
  },
  "/batch": {
    title: "Batch PDF Processing - Private Bulk Tools | PDF Chef",
    description: "Run compression, conversion, security, metadata, page, and repair operations across several PDFs locally.",
  },
  "/invoice": {
    title: "Free Invoice Maker - Create an Invoice PDF | PDF Chef",
    description: "Make a professional invoice PDF in your browser. Add your logo, colour and tax, and nothing is uploaded.",
  },
  "/receipt": {
    title: "Free Receipt Maker - Create a Receipt PDF | PDF Chef",
    description: "Make a receipt PDF that proves a payment was made. Add your logo and colour, entirely on your device.",
  },
  "/quote": {
    title: "Free Quote Maker - Create a Quote or Estimate PDF | PDF Chef",
    description: "Make a quote or estimate PDF for a job. Add your logo, colour and tax, with nothing uploaded anywhere.",
  },
  // A personal, device-local list. There is nothing here for a searcher, and
  // /history is the same screen under an older path.
  "/recent": {
    noindex: true,
    title: "Local Output History | PDF Chef",
    description: "Re-download and manage PDF Chef outputs stored only in this browser.",
  },
  "/history": {
    noindex: true,
    canonical: "/recent",
    title: "Local Output History | PDF Chef",
    description: "Re-download and manage PDF Chef outputs stored only in this browser.",
  },
  "/settings": {
    noindex: true,
    title: "Settings | PDF Chef",
    description: "Control local history, download behavior, and large-file safety preferences for PDF Chef.",
  },
  "/help": {
    title: "PDF Chef Help - Frequently Asked Questions",
    description: "Answers about PDF Chef: whether files are uploaded, how compression affects quality, offline use, merging and splitting limits, and where results are kept.",
  },
  "/privacy": {
    title: "Privacy Policy | PDF Chef",
    description: "Read the PDF Chef privacy policy for the Android app and web app.",
  },
  "/privacy-policy": {
    canonical: "/privacy",
    title: "Privacy Policy | PDF Chef",
    description: "Read the PDF Chef privacy policy.",
  },
  // Renders the very same PrivacyPolicy component, so it is a duplicate rather
  // than an Android-specific document, and its title said otherwise.
  "/pdf-chef-privacy": {
    canonical: "/privacy",
    title: "Privacy Policy | PDF Chef",
    description: "Read the PDF Chef privacy policy covering the web app, Android app and iOS app.",
  },
  "/terms": {
    title: "Terms and Conditions | PDF Chef",
    description: "Read the PDF Chef terms and conditions.",
  },
  "/terms-and-conditions": {
    canonical: "/terms",
    title: "Terms and Conditions | PDF Chef",
    description: "Read the PDF Chef terms and conditions.",
  },
};

const escapeAttribute = (value) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const escapeText = (value) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const replaceTag = (html, pattern, replacement) => html.replace(pattern, replacement);

const appendCspSource = (policy, directiveName, source) => {
  const directives = policy.split(";").map((directive) => directive.trim());
  const index = directives.findIndex((directive) => directive === directiveName || directive.startsWith(`${directiveName} `));
  if (index < 0) return policy;

  const sources = directives[index].split(/\s+/);
  if (!sources.includes(source)) sources.push(source);
  directives[index] = sources.join(" ");
  return directives.filter(Boolean).join("; ");
};

const allowCloudflareWebAnalytics = (html) => html.replace(
  /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)("\s*\/?>)/i,
  (_match, prefix, policy, suffix) => {
    const withScript = appendCspSource(policy, "script-src", WEB_ANALYTICS_SCRIPT_ORIGIN);
    const withConnection = appendCspSource(withScript, "connect-src", WEB_ANALYTICS_CONNECT_ORIGIN);
    return `${prefix}${withConnection}${suffix}`;
  },
);

/** Every path the app actually renders something for; see routeMeta above. */
const isKnownRoute = (pathname) => {
  const normalizedPath = pathname === "/" ? "/" : pathname.replace(/\/+$/, "");
  return Object.prototype.hasOwnProperty.call(routeMeta, normalizedPath);
};

const applyRouteMeta = (html, pathname) => {
  const normalizedPath = pathname === "/" ? "/" : pathname.replace(/\/+$/, "");
  const meta = routeMeta[normalizedPath];
  if (!meta) return html;

  // A duplicate route points at the URL that should rank; everything else points
  // at itself. Without this, /privacy, /privacy-policy and /pdf-chef-privacy all
  // claimed to be the original of the same document.
  const canonicalPath = meta.canonical || normalizedPath;
  const canonicalUrl = `${ORIGIN}${canonicalPath === "/" ? "/" : canonicalPath}`;
  const title = escapeText(meta.title);
  const titleAttr = escapeAttribute(meta.title);
  const descriptionAttr = escapeAttribute(meta.description);
  const canonicalAttr = escapeAttribute(canonicalUrl);

  let nextHtml = html;
  nextHtml = replaceTag(nextHtml, /<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`);
  nextHtml = replaceTag(nextHtml, /<meta\s+name="title"\s+content="[^"]*"\s*\/?>/i, `<meta name="title" content="${titleAttr}" />`);
  nextHtml = replaceTag(nextHtml, /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i, `<meta name="description" content="${descriptionAttr}" />`);
  nextHtml = replaceTag(nextHtml, /<meta\s+property="og:url"\s+content="[^"]*"\s*\/?>/i, `<meta property="og:url" content="${canonicalAttr}" />`);
  nextHtml = replaceTag(nextHtml, /<meta\s+property="og:title"\s+content="[^"]*"\s*\/?>/i, `<meta property="og:title" content="${titleAttr}" />`);
  nextHtml = replaceTag(nextHtml, /<meta\s+property="og:description"\s+content="[^"]*"\s*\/?>/i, `<meta property="og:description" content="${descriptionAttr}" />`);
  nextHtml = replaceTag(nextHtml, /<meta\s+property="twitter:url"\s+content="[^"]*"\s*\/?>/i, `<meta property="twitter:url" content="${canonicalAttr}" />`);
  nextHtml = replaceTag(nextHtml, /<meta\s+property="twitter:title"\s+content="[^"]*"\s*\/?>/i, `<meta property="twitter:title" content="${titleAttr}" />`);
  nextHtml = replaceTag(nextHtml, /<meta\s+property="twitter:description"\s+content="[^"]*"\s*\/?>/i, `<meta property="twitter:description" content="${descriptionAttr}" />`);
  nextHtml = replaceTag(nextHtml, /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/i, `<link rel="canonical" href="${canonicalAttr}" />`);
  // `follow` rather than `none`: these pages still link onward to the tools.
  if (meta.noindex) {
    nextHtml = replaceTag(nextHtml, /<meta\s+name="robots"\s+content="[^"]*"\s*\/?>/i, `<meta name="robots" content="noindex, follow" />`);
  }

  return nextHtml;
};

export async function onRequest(context) {
  const url = new URL(context.request.url);

  if (url.hostname === "pdftools.dhananjaytech.app") {
    url.hostname = "pdfchef.dhananjaytech.app";
    return Response.redirect(url.toString(), 308);
  }

  const response = await context.next();
  const contentType = response.headers.get("content-type") || "";
  if (context.request.method !== "GET") {
    return response;
  }

  if (!contentType.includes("text/html")) {
    const isHashedAsset = url.pathname.startsWith("/assets/");
    const isStableShellFile = url.pathname === "/sw.js" || url.pathname === "/site.webmanifest";
    if (!isHashedAsset && !isStableShellFile) return response;

    const headers = new Headers(response.headers);
    headers.set(
      "Cache-Control",
      isHashedAsset
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const html = await response.text();
  const analyticsReadyHtml = url.origin === ORIGIN ? allowCloudflareWebAnalytics(html) : html;
  const rewrittenHtml = applyRouteMeta(analyticsReadyHtml, url.pathname);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("Cache-Control", "no-cache");
  // `/*  /index.html  200` in public/_redirects means a typo, a stale backlink or
  // a scraped junk URL is served the shell with a 200 and the default metadata:
  // a soft 404, which Search Console flags and which lets any URL variant
  // accumulate signals. The body still loads the app, so the client-side
  // redirect to Home is unchanged; only the status a crawler reads differs.
  const status = isKnownRoute(url.pathname) ? response.status : 404;
  return new Response(rewrittenHtml, {
    status,
    statusText: response.statusText,
    headers,
  });
}
