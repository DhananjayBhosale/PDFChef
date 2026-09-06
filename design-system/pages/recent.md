# Page Override

## Screen

- Name: Recent (the second tab, route `/recent`; `/history` is a preserved alias)
- User goal: find something produced earlier, confirm it is still on the device,
  and save, share, reopen, rename or delete it without doubt about scope

## Deviations from master

- The row takes the shape the Android app's Recent list had: an icon bubble, the
  filename, a tool chip beside the output size, and the date on its own line
  under them. Three lines, no more. Input size, output size and the measured
  saving are not all spelled out per row; the size that matters is the one the
  file is now.
- Tapping the row opens the result. Holding it starts a selection. Everything
  else is behind one control at the end of the row, so a row has one obvious
  action and no button pair competing with it.
- Availability is part of the row, not a failure discovered on tap. A record
  whose file is gone shows a distinct icon and one word, `Missing`.
- The item count and Select sit beside the title in the header, where a
  list-wide fact and a list-wide action belong. There is no summary strip; the
  only thing above the list is the total saving, and only when there is one.
- Row actions live in a sheet rather than a swipe. A swipe is invisible to
  keyboard and VoiceOver users and cannot carry six actions.
- Open appears in that sheet only for a PDF that is still present, because that
  is the only thing the viewer can accept. A group's sheet says in one line why
  it has neither Open nor Rename.
- Sort sits at the end of the search field's row rather than taking a second
  full-width row on a phone.
- Clearing offers a second action, delete the files only, when and only when the
  platform can separate a record from the file it points at. Where it cannot,
  the action is absent rather than present-but-dead with a sentence beneath it.
- Every destructive action confirms, names the exact scope, and states that
  copies already saved elsewhere are untouched. Because every one of them does,
  the screen header does not say it a second time: the boundary belongs at the
  press that decides something, and three lines of it above the first row is
  three fewer rows of what the person came for.

## States

Loading is three skeleton rows in place. Error shows the message and a retry.
Empty is an icon, a title and the tools tab; a filtered-empty is the title and a
way to clear the search, with no line under it restating either. Success from an
action appears as a polite status line above the list, not a toast over content.

## Constraints

- Reads and writes only through the typed ports in
  `hooks/useWorkspaceRuntime.tsx`. No direct persistence decisions here.
- Unknown values are rendered as unknown. Never inferred.
- Long filenames wrap; they are never truncated so that the extension is lost.
