# Page Override

## Screen

- Name: Settings (the third tab, route `/settings`)
- User goal: change how the app looks and behaves, understand what is stored,
  and remove it

## Groups, in order

1. **Appearance** — theme (System / Light / Dark), readable text size, interface
   font, with labels but no helper or preview copy.
2. **Space saved** — only the measured dynamic value, or “Nothing measured yet.”
3. **Documents and history** — keep results, save on finish, storage used, clear
   Recent.
4. **Large documents** — warn before a heavy job, and the threshold. The
   threshold field disables when the warning is off, because it has no meaning
   then.
5. **Privacy** — the essential on-device processing and review warnings, plus
   legal links.
6. **About** — concise version, open-source licenses, GitHub source link.
7. **Reset** — returns preferences to default behind a scoped confirmation.

## Deviations from master

- Grouped inset lists with a caption heading above each group, which is what iOS
  Settings does and what makes a long settings screen scannable.
- Rows and switches use one concise label by default. No helper text repeats a
  control, value, or group heading.
- Storage usage reports what the platform port says. With no port injected it
  reports “About X used” rather than showing a made-up device-wide number.
- Privacy, data-loss, legal, confirmation, live error, and safety copy remains
  because removing it would reduce informed control.
- The retention row names the store the running shell actually has: a packaged
  build says its app storage, a browser build says the browser's data. The
  answer comes from the existing capability flag, not from a user-agent guess,
  and the browser sentence is not softened to make one line serve both.
- Rows, switches and segmented controls run at the Android app's list density.
  A segment is a 38px box in a 46px shell and a switch is 51x31; both reach the
  48px floor through their hit extension, so the screen gets shorter without any
  target getting smaller.

## Constraints

- Appearance is presentation and lives in `hooks/useAppearance.tsx`. Everything
  describing documents or history is stored by engineering through
  `services/workspace.ts` and the typed ports.
- Clear and Reset are separate actions with separate confirmations, and neither
  copy may imply that files saved elsewhere are affected.
- No preference may imply a cloud, an account, or a sync.
- Preserve screen-reader labels, segmented-control names, confirmation titles
  and buttons, and live status behavior even when visible supporting copy is
  removed.

## Identity update

The layout is unchanged. The screen takes the new tokens (warm paper, one tomato
accent) and the serif title (`--font-display`).
