/**
 * Errors about a file that did not open are shown inside the drop zone, under its label (T-09).
 * A tool's floating status hands its failure here while a drop zone is on screen.
 */
let mounted = 0;
let handed = '';
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
// What the last drop zone on a route took, so the loaded tool can take a drop the same way.
let zoneAccept: { path: string; accept: string } | null = null;

export const registerDropZone = (accept: string) => {
  mounted += 1;
  zoneAccept = { path: window.location.pathname, accept };
  return () => { mounted -= 1; };
};
export const dropZoneAcceptOn = (path: string) => (zoneAccept?.path === path ? zoneAccept.accept : null);
export const dropZoneShown = () => mounted > 0;
export const setDropZoneError = (message: string) => {
  if (message === handed) return;
  handed = message;
  emit();
};
export const subscribeDropZoneError = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const getDropZoneError = () => handed;

/**
 * The last single file a drop zone took on this route, in memory only. An error's link to the next
 * tool ("Unlock it with Unlock PDF first") hands it on, so it need not be chosen again (research r2,
 * mobile-06).
 */
let picked: { path: string; file: File } | null = null;
export const rememberPickedFile = (path: string, files: File[]) => {
  picked = files.length === 1 ? { path, file: files[0] } : null;
};
export const pickedFileOn = (path: string) => (picked?.path === path ? picked.file : null);
