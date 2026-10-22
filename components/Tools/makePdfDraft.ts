/**
 * Create PDF's page list and typed name, kept while a result opened from it is
 * on top, so Back from Open PDF or Show in Recent finds the screen as it was
 * left. Memory only, for this session; any other way of leaving lets it go.
 */
export interface DraftPage {
  id: string;
  file: File;
  previewUrl: string;
}

export const makePdfDraft: { pages: DraftPage[]; typedName: string | null; exported: DraftPage[] | null } = {
  pages: [],
  typedName: null,
  exported: null,
};

export const releaseMakePdfDraft = () => {
  for (const page of makePdfDraft.pages) URL.revokeObjectURL(page.previewUrl);
  makePdfDraft.pages = [];
  makePdfDraft.typedName = null;
  makePdfDraft.exported = null;
};

/**
 * Leaving keeps the pages only when it moved forward from Create PDF's own
 * history entry (a result's Open PDF or Show in Recent) after exactly this list
 * was exported. Back, a tab, or Discard on pages not yet exported lets them go.
 */
export const keepsMakePdfDraftOnLeave = (entryIndex: number, nextIndex: number) =>
  nextIndex > entryIndex && makePdfDraft.pages.length > 0 && makePdfDraft.pages === makePdfDraft.exported;
