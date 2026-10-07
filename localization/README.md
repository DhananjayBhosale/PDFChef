# PDF Chef localization

**Current status: incomplete.** See [HANDOFF.md](HANDOFF.md) and `status.json`
for review coverage and verification blockers. All 24 application locales have
complete catalogs; the 20 non-English catalogs are installed and `drafts/` mirrors
their current text. Mandatory final model review remains incomplete.

The shared React application owns application translations. Native resource packages in
`native-handoff/` are prepared text only. Nothing in this directory uploads store
metadata, changes prices or enables billing.

## Application catalogs

- `services/i18n/en-US.ts` is the complete typed source and fallback catalog.
- `services/i18n/locales/*.ts` contains locally bundled translations. Regional English
  inherits en-US. Only the selected catalog is imported; the service worker caches
  all emitted locale chunks for subsequent offline language changes.
- `services/i18n/core.ts` provides synchronous `t`, named interpolation, Intl plural
  selection and date/number/currency formatting after catalog loading.
- `useI18n()` subscribes only components displaying localized copy. Language changes
  do not remount the application or replace PDF document content.
- Settings defaults to System language. An explicit preference is stored in
  `pdfchef.locale.v1`. Unsupported device languages fall back to en-US.

Keep translation keys stable when editing wording. Use complete contextual sentences
and plural objects rather than concatenating grammatical fragments. Keep placeholders
identical in every plural category. Display prices supplied by the store without
reformatting or inferring a different currency. Never translate document content,
file names, tool IDs, routes, business-document fields authored by users or diagnostic
identifiers used by processing guards.

Some short labels need their source context during review:

- `business-document-builder.paid.by.a891cb` is the receipt's payment method
  (card, cash or bank transfer), not the payer's name.
- `recent-page.deleted.of.could.not.be.deleted.5e0a59` uses `v0` for successful
  deletions, `v1` for attempted deletions and `count` for failures. Only `count`
  selects the plural form; the first clause must work independently of it.
- `metadata-pdf.saved.as.pdf.by.854dda` labels the PDF Producer application.
- Settings Serif/Monospace labels are generic styles; actual font-family names
  such as Inter and Noto Sans remain unchanged.
- The direct-edit error about a “shared form” refers to a reusable PDF Form XObject,
  not an interactive fillable form. Keep processing diagnostics stable while
  making this distinction in translated display text.
- Pro export unlocking is different from removing a document password. Preserve
  that distinction and every privacy, legal and entitlement qualification.

Locale formatting is for visible text. CSS geometry, identifiers, numeric input
values and PDF content retain their machine/document representation.

Inter remains the preferred interface font, with local system fallbacks for missing
glyphs. Arabic changes interface direction; document coordinate spaces, signatures,
artwork and the logo retain their direction and orientation.

## Prepared store and native packages

`locale-mapping.json` maps all application locales to Apple and Google identifiers,
text direction and English fallback. Latin American Spanish maps to Apple's es-MX.
Store packages have separate Apple and Google fields. Google purchase fields are a
future integration handoff, not a claim that Android billing is currently enabled.

`stores/limits.json` records platform limits and their official references. Screenshot
captions have a project limit; they are not a separately uploaded store text field.
Replace the What's New placeholders with verified release changes and rerun validation
before any future publication. `stores/keyword-research.json` records region-specific
search terminology and qualitative sources, not measured search volume or rankings.

`native-handoff/source-map.json` links text to read-only native source locations.
Native owners must integrate these translations into their platform resources,
connect language selection where appropriate, and verify native layouts separately.
System-owned picker, permission and purchase interfaces follow platform localization.
Do not replace system UI with custom translations of price or purchase facts.

All non-English legal translations require professional legal review. The application
marks this and keeps the original English pages available as the authoritative text.
Model review is not native-speaker or legal review.

## Checks

```sh
node scripts/check-localization.mjs
node scripts/check-localization.mjs --drafts
node scripts/check-localization-assets.mjs
node --experimental-strip-types --test tests/localization/core.test.ts
npm run test:catalog
npm run lint
node scripts/verify-localization-mobile.mjs
```

The mobile check defaults to en-US, de-DE, fr-FR, ja-JP, zh-Hans, hi-IN and ar-SA.
It visits every route in German and Arabic, checks large text, language persistence,
missing-key warnings and an unchanged editable English PDF. Set `PDF_CHEF_URL` to a
local preview origin; no deployment is needed. Production verification can use
`PDF_CHEF_DIST_DIR` to isolate build output from normal web/native packaging.

Review and completion evidence for this work is recorded separately; this document
is an integration guide, not a claim that all review or publication gates have passed.
