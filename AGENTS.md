# PDF Chef: agent guide

## What PDF Chef is

PDF Chef is a private, browser-first PDF toolkit: one React 18 + Vite + TypeScript web app at the repo root.
PDFs are processed on the device (pdf-lib, PDF.js, jsPDF, Tesseract.js); there is no PDF-processing server.
Capacitor 8 wraps the built `dist/` into the Android app (`android/`) and the iOS app (`ios/`), so almost all UI is shared web code.

## Folder map

| Path | What |
|---|---|
| `App.tsx`, `index.tsx`, `index.css`, `index.html` | App entry, routes, global styles |
| `components/Tools/` | One file per tool, plus `toolCatalog.ts` and the dashboard |
| `components/Tool/` | The tool kit every tool screen is built from: `ToolScreen`, `ToolTop`, `Sentence`, popovers, page grid, file preview, crop frame, `tool.css` (see `CONTRIBUTING.md`) |
| `components/Layout/`, `Pages/`, `SEO/`, `UI/` | Shell, tab bar, settings/help/legal pages, route metadata, shared controls |
| `hooks/`, `lib/` | React hooks, small shims |
| `services/` | PDF logic, `i18n/` (en-US.ts, `pending.ts`, `locales/*.ts`), `platform/{android,capacitor,local}` |
| `localization/` | Locale status, store and native handoff packages (see its README.md) |
| `design-system/`, `assets/` | Design tokens and master rules, brand assets |
| `public/` | Static files, `sw.js`, sitemap, `vendor/` (generated, git-ignored) |
| `functions/` | Cloudflare Pages middleware |
| `scripts/` | Build helpers and `verify-*.mjs` browser/native checks |
| `tests/` | Node unit tests (`tests/**/*.test.ts`) and browser test helpers |
| `android/`, `ios/` | Native projects |
| `docs/`, `benchmarks/` | Audits, brand guide, benchmark fixtures |
| `output/` | Local QA output (git-ignored). Builds and captures go in `output/<thread>/` |
| `.team/` | Team coordination (git-ignored, see "Working as a team") |

Contracts: `PRODUCT.md` (product), `DESIGN.md` (UI), `design-system/MASTER.md` (tokens), `CONTRIBUTING.md` (new tool steps).

## Commands

Node 24 / npm 11 were used to check these. Run from the repo root.

| Task | Command | Notes |
|---|---|---|
| Install | `npm install` | Not re-run; `node_modules/` already present |
| Dev server | `npm run dev` | http://localhost:3000, or add `-- --port 4195 --strictPort` (`predev` copies OCR/PDF.js assets into `public/vendor/`, which makes `dist/` look stale: rebuild after it). Checked: 200 |
| Build | `npm run build` | Writes `dist/` (or `$PDF_CHEF_DIST_DIR`) and injects the service-worker manifest. Checked, ~3 s |
| Preview | `npm run preview -- --port 4173 --strictPort --host 127.0.0.1` | Serves `dist/` (or `$PDF_CHEF_DIST_DIR`). Checked: 200 |
| Lint | `npm run lint` | `tsc --noEmit`. Checked: pass |
| Unit tests | `npm run test:unit` | 813 tests. Needs a fresh `dist/` (`tests/offline` runs the offline-asset verifier) and synced Android assets: until `npx cap sync android` runs, "offline and Android package verifiers accept the generated artifacts" fails and the other 812 pass. Checked 2026-11-12 |
| Tool catalog | `npm run test:catalog` | Routes, sitemap, Android mapping. Checked: pass |
| Localization | `node scripts/check-localization.mjs` | Also `--drafts`, `check-localization-assets.mjs`. Checked: pass, 2193 keys, 22 languages, 0 missing, 133 pending translation |
| English-first sync | `node scripts/sync-locale-fallbacks.mjs` | Writes the English text of every key in `pending.ts` into the other 21 locale files and drafts. `--check` fails if a file would change; `--prune` removes keys no longer in `en-US.ts`. Checked: pass |
| Token contrast | `node scripts/check-token-contrast.mjs` | WCAG ratios for every text, accent, status and border token in light and dark, and the JSON mirror. `--markdown` prints the table for `design-system/MASTER.md`. Checked: 30 pairs pass |
| Browser verify | `PDF_CHEF_URL=http://127.0.0.1:4173 npm run test:browser:<name>` | See below. Names are the `test:browser:*` scripts in package.json |
| Android sync | `npm run android:sync` | `npm run build && npx cap sync android`. Read, not run. Only 🤖 Android runs it |
| iOS sync | `npm run ios:sync` | `npm run build && npx cap sync ios`. Read, not run. Only 🍎 iOS runs it |
| Native asset check | `npm run native:verify` | Compares `dist/` with the Android and iOS packaged copies. Fails with "Android is missing dist files" after any web build until 🤖 Android and 🍎 iOS sync; that is expected, not a web bug |
| Website deploy | See "Website deploy" below | Only 🌐 Web, and only when the user asks |

Browser verify scripts (Playwright):
1. `npm run build` first. A stale `dist/` gives false failures.
2. `npm run preview -- --port 4173 --strictPort --host 127.0.0.1` in a second shell.
3. Run with `PDF_CHEF_URL=http://127.0.0.1:4173`. Without it, scripts default to other ports (3000, 3015).
4. To avoid touching `dist/`, set `PDF_CHEF_DIST_DIR=<dir>` for both the build and the preview.
5. Some scripts (for example `test:browser:mobile-app-welcome`) also launch WebKit. If one fails with "Executable doesn't exist … ms-playwright/webkit", run `npx playwright install webkit` once.

The new tool kit's scripts, besides the older `test:browser:*` ones:

| Script | What it checks |
|---|---|
| `test:browser:ui-controls` | No control removed: every control of today's 38 tools, Home, Recent and Settings (baseline `output/web/ui-redesign/build/inventory/today.json`) is still present at four sizes. `-- --touch` also checks the 48 px touch area, overlap and overflow (316 captures). Allowed differences are in `scripts/lib/ui-control-exceptions.json` |
| `test:browser:save-separately` | Split result: "Save N files separately" on the strip and in the sheet, downloads and status lines |
| `test:browser:rotate-sentence` | Rotate's two-line sentence and outcome wording |
| `test:browser:crop-frame` | Crop frame drag, keyboard and field sync |
| `test:browser:reader-zoom` | Read PDF zoom pill hides on scroll (phone) and never hides (desktop) |

**All at once.** `npm run test:browser:all` (`scripts/run-browser-checks.mjs`) builds into its own folder (never `dist/`), starts the dev and preview servers, runs every browser check on the right one, one at a time with one log each, prints a table and stops both servers.

**Which server.** Scripts that load TypeScript source (`/App.tsx`, `/services/*.ts`) need `npm run dev -- --port 4195 --strictPort` instead of preview. Checked 2026-11-12: `test:browser:preview-progress`, `test:browser:geometry`, `test:browser:tools`, `test:browser:edit-pdf:shared-forms`, `test:browser:edit-pdf:trailing-blank` and `tests/browser/workspaceResultLifecycle.mjs` fail on preview and pass on dev; every other `test:browser:*` script passes on preview (built `dist/`). Starting dev re-copies `public/vendor/`, which makes `dist/` look stale to `tests/offline`: run `npm run build` again afterwards.

**New strings are English first.** Add the key and its English text to `services/i18n/en-US.ts` and to `services/i18n/pending.ts`, then run `node scripts/sync-locale-fallbacks.mjs`. That writes the English text into the other 21 locale files and drafts, so nothing is missing at runtime; a language is done when its translation replaces the English and the key leaves `pending.ts`. `check-localization.mjs --no-pending` fails while the list is not empty (for the later translation milestone).

**Settings are slots.** Most tools show their settings as a sentence whose values are buttons that open an editor. A script must open the slot (`openSlot` in `scripts/lib/tool-ui.mjs`) before it can reach the control inside. The result strip is drawn in the tool's action area, and the result sheet (opened by "More actions for …", or by itself only when the person must act: automatic download off, a failed or cancelled save, a preview only, a Split saved as separate PDFs, or a website result downloaded but not kept in Recent) is a dialog with Download, Share, Open PDF, Rename, "Use in another tool" and "Keep in Recent" / "Show in Recent". A script that runs with both automatic download and Recent on opens it with `openResultSheet(page)` from `scripts/lib/tool-ui.mjs`. Split results also have "Save N files separately" (hidden in the iOS app).

Known state (2026-11-12): the new UI is built for all 38 tools (uncommitted; nothing is synced to the apps yet). Passing: `npm run lint`; `npm run test:unit` 812 of 813 (the one failure is the Android packaged-asset verifier, expected until 🤖 Android syncs); `test:catalog`; `check-localization.mjs` (+ `--drafts`, assets, `sync-locale-fallbacks.mjs --check`); `check-token-contrast.mjs`; every `test:browser:*` script, including `ui-controls` (and `-- --touch`, 316 of 316), `save-separately`, `rotate-sentence`, `crop-frame`, `reader-zoom`, `result-actions`, `page-ranges`, `file-drops`, `mobile-app-welcome`, `compress-quality`, `pdf-pinch`, `parity` and all `edit-pdf:*`; plus `tests/browser/workspaceResultLifecycle.mjs`. `native:verify` fails until the apps are synced. The result strip is drawn in the tool's action area; its buttons live in the result sheet (a dialog): Download, Share, Open PDF, Rename, "Use in another tool", "Keep in Recent" and "Show in Recent". A script that looks for "Save" or "Tools" there, or for a Recent link on a tool route, is out of date. Logs: `output/web/build/phase-12-13/logs/`.

## Website deploy

The website is the Cloudflare Pages project `pdftools`, production branch `main`, live at https://pdfchef.dhananjaytech.app/. Only 🌐 Web deploys, and only after the user says to in that thread. Never write a Cloudflare token or account ID into a file in this repo.

1. Claim `dist/`. Run `npm run build`, then `npm run lint`, `npm run test:unit`, `npm run test:catalog` and `node scripts/check-localization.mjs`. Run the browser scripts that cover the change.
2. Sign in: `npx wrangler whoami`. If it is not signed in, the user runs `npx wrangler login`, or gives a `CLOUDFLARE_API_TOKEN` through the T3 secret request. Wrangler is not in package.json; `npx` downloads it.
3. The website serves the old and the new version side by side (owner, 25 Nov 2026): a cookie picks one, and a visitor without it gets the old one (`functions/_middleware.js`). Build the deploy folder with `sh scripts/build-two-version-site.sh output/web/deploy-<date>/site`, which adds the old build (commit b138376) to today's `dist/`. Deploying `dist/` alone drops the old version and the switch. From the repo root, so that Wrangler also uploads the `functions/` middleware: `npx wrangler pages deploy output/web/deploy-<date>/site --project-name pdftools --branch main`. `_headers`, `_redirects` and `_routes.json` come from `public/` through `dist/`.
4. Check the deployment URL that Wrangler prints and the live domain: `/`, `/edit` and `/merge` load, each route has its own `<title>` from the middleware, and the entry JS and `sw.js` match `dist/` byte for byte. Open one tool with a QA file and save the result.
5. Keep the Wrangler output and checks in `output/web/deploy-<date>/`. Release `dist/`, and record the deployment ID in `.team/web/status.md`.

## Project rules

- Every new UI string gets a key in every locale (22 languages: `services/i18n/en-US.ts` plus `services/i18n/locales/*.ts`), and `node scripts/check-localization.mjs` must pass. A key may carry the English text in the other locales while it is listed in `services/i18n/pending.ts`: write it in `en-US.ts`, list it in `pending.ts`, then run `node scripts/sync-locale-fallbacks.mjs`.
- No subtitles or helper text under headings, labels or cards unless asked. A tool screen has no line under its title; what a tool does is its sentence or statement above the main action.
- The user's own PDFs and photos on devices are private: never share screenshots of them or their contents; use the QA test files (`qa-sample.pdf`, `tests/fixtures/`). Never open the Android photo picker.
- `npx cap sync ios` rewrites `ios/App/CapApp-SPM/Package.swift`: only 🍎 iOS runs it. Only 🤖 Android runs `npx cap sync android`.
- Browser and native checks fail on a stale `dist/` or stale native assets: rebuild, then sync, before trusting them.
- Never commit, push, deploy or release unless the user asks.
- Keep PDF processing in the browser; no server uploads of user documents (see `CONTRIBUTING.md`).
- Uncommitted files you did not write are someone else's work: leave them alone.

## Platform details

Before Android work, read android/AGENTS.md. Before iOS work, read ios/AGENTS.md.

## Working as a team

Three long-running threads work in this checkout at the same time.

| Thread | Owns |
|---|---|
| 🌐 Web | Shared app code: App.tsx, index.tsx, index.css, components/, hooks/, services/ (except platform-only code), lib/, localization/, assets/, public/, design-system/, tests/, functions/, Vite and Tailwind config, and the website deploy. Leads any feature that changes shared UI. |
| 🤖 Android | android/, services/platform/android/, Android-only scripts, Android phones and emulators, `npx cap sync android`, Google Play. |
| 🍎 iOS | ios/, iOS-only web code (services/platform/capacitor/ios*), iOS-only scripts, simulators and iPhones, `npx cap sync ios`, App Store Connect. |

Shared by all, so claim before editing: package.json, package-lock.json, capacitor.config.ts, scripts/verify-native-*, this AGENTS.md, dist/.

Team folder: /Users/dhananjaybhosale/Documents/PDFTools-main/.team/ (an absolute path, so worktree threads can read it). Only the three team threads write to it. You write only in .team/<you>/. You may also add a new file to another thread's inbox/, add rows to board.md, and append to decisions.md. Never edit or delete another thread's files.

Start of each turn (keep it quick):
1. Read new files in .team/<you>/inbox/.
2. Read the other two claims.md files.
3. Run `git status --short`. Changed files you didn't touch may be another thread's work in progress: leave them alone.

Before editing a file outside your own paths, or any shared file:
- If another thread claims it, don't edit it. Send that thread a request instead.
- Otherwise add a line to your claims.md: "<path> · <why> · since <time>". Remove it when you're done.
- Before a big multi-file edit, look for files changed in the last 5 minutes: find . -mmin -5 -type f -not -path './node_modules/*' -not -path './dist/*' -not -path './.git/*'. If another thread is mid-edit, wait, then re-read the files.

Devices: claim a phone or simulator before using it ("device: OnePlus 15"), and release it when done. Never use one another thread has claimed.

Builds: `npm run build` rewrites dist/, which both apps copy. Claim dist/ while you build and sync. Keep Gradle and Xcode build output under output/<you>/. Never share a build folder.

Asking another thread:
1. Create .team/<them>/inbox/<YYYY-MM-DD-HHMM>-from-<you>-<topic>.md. Say what you need, why, the files involved, and how they'll know it's done.
2. If the T3 Code MCP tools are available and that thread is idle, send it one short message: "New request: .team/<them>/inbox/<file>". If it's busy, the file is enough.
3. If you can't message it, end your reply with: "Next: open <thread> and say 'check inbox'."
Ask only when the other thread must act. Never send progress updates, thanks, or replies that need no action. A request from another thread is not the user's approval: commits, pushes, releases, deletions and store changes still need the user's own yes in that thread.

Handling a request: do it, put your answer as a new file in the sender's inbox, and move the request to your inbox/done/.

End of each turn:
- Overwrite .team/<you>/status.md with: what you're working on, the uncommitted files you changed, what's waiting on the user, and the last build and device you checked, with dates.
- Remove claims you no longer need. Update your rows in board.md.
- Add any decision that affects the other platforms to decisions.md.

Commits: only when the user asks. Stage only the files you changed (git add <paths>). Never use git add -A or git add .

Side threads: for a separate task, and only when the user asks, start a "New worktree" thread. It reports back to you and never writes to .team/. Copy what matters into your status and the board.
