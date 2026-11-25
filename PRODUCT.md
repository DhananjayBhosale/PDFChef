# PDF Chef Product Contract

## Product intent

PDF Chef is a private, browser-first PDF workspace. A user should be able to choose a tool, process a document on the device, inspect the result, and save or clear it without an account or a PDF-processing server. The product voice is calm, direct, and honest about beta quality, supported formats, and output limitations.

## Core promise and boundaries

- Normal PDF workflows process selected bytes locally in the browser; never imply that a file was uploaded, synced, or backed up.
- Local output history is optional, browser/device scoped, capped, and clearable. A saved download is outside PDF Chef's control.
- Password values are user data: preserve them exactly, do not trim or echo them, and state when they are required.
- “Works offline” means after the application assets have loaded; conversion and large jobs still depend on browser memory and supported format behavior.
- Make Fillable and Edit PDF are review-first beta surfaces. Detection creates suggestions, not verified form semantics; users must inspect every field and output.

## Primary journeys

1. Dashboard: understand privacy, search or filter the catalog, and start one tool quickly. Recent tools are a convenience, not a second navigation system.
2. Single-file tool: select/drop an accepted file, see constraints before processing, read the one sentence that says what the action will do, receive progress or a useful error, then use the result strip in the tool's action area to save, share when supported, rename, or open local history. A split that makes several files can also save them separately, each as its own file, where the platform allows it.
3. Forms/editor: open a PDF, navigate pages, add or edit content with visible selection, undo/redo where available, and save only after the user can review the page and field list.
4. Batch: select multiple PDFs, choose one operation, see the ordered queue and per-file progress, then receive one ZIP. Partial failures remain inspectable in `failures.txt`; an all-failed batch is an error.
5. History/settings: explain local retention, allow individual or full deletion, and expose interface, download, memory-warning, and history preferences without implying cloud settings.

## Capability copy contract

- Office conversion must disclose fidelity. Word to PDF retains text-oriented structure (paragraphs, line breaks, tabs, table-cell text, explicit page breaks) but not fonts, styling, images, or table grids. PowerPoint to PDF may substitute fonts and excludes notes, animations, video, and audio; users review before sharing.
- PDF to Word is a searchable-text export, not a promise of visual/layout parity.
- “Detect fields” is local label/shape detection. Say “suggestions” and “Review every field”; never present detection as accuracy certification.
- Output messaging identifies the filename, size, local-retention state, and next action. Never call a result “secure” merely because it was processed locally.
- Large-file warnings describe possible browser memory pressure and allow the user to continue or cancel.

## Acceptance principles

- Every long-running operation has an idle, working, success, partial-success, and failure state; progress text names the current file/page where meaningful.
- Empty states explain the next action. Destructive actions identify the exact local scope and preserve already-downloaded files.
- Keyboard, screen-reader, touch, dark theme, and increased-text-size use must retain the same task order and status information.
- Product parity is behavioral and semantic before visual: route, tool name, accepted input, limitation copy, output naming, privacy claim, and recovery path must agree across dashboard and tool surfaces.

