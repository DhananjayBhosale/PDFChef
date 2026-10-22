import type { NavigateFunction } from 'react-router-dom';

/**
 * Where Back and the Tools tab go. Tabs take each other's place in history
 * instead of stacking, so Back on Tools leaves the app the way other Android
 * apps with a tab bar do, rather than replaying every tab and tool visited.
 */

/** Marks an entry a tab opened, so Back from it goes to Tools rather than to the screen it replaced. */
export const TAB_ENTRY = { tab: true } as const;

export const openedByTab = (state: unknown): boolean =>
  typeof state === 'object' && state !== null && (state as { tab?: unknown }).tab === true;

/** React Router's position in session history: 0 on the first entry. */
export const historyIndex = (state: unknown = window.history.state): number => {
  const index = typeof state === 'object' && state !== null ? (state as { idx?: unknown }).idx : undefined;
  return typeof index === 'number' && Number.isSafeInteger(index) && index > 0 ? index : 0;
};

// The path at each history index this session has seen. After a reload the
// entries behind are unknown, and returning to Tools replaces instead.
const pathsByIndex: string[] = [];

/** Called on every location change, so returning to Tools can tell what is behind. */
export const rememberHistoryEntry = (path: string, pushed: boolean, index = historyIndex()) => {
  if (pushed) pathsByIndex.length = index;
  pathsByIndex[index] = path;
};

/**
 * Tools home without a second copy of it: step back when Tools is the entry
 * just behind, as the nav bar's Back does, and replace this entry otherwise.
 */
export const returnToTools = (navigate: NavigateFunction, index = historyIndex()) => {
  if (index > 0 && pathsByIndex[index - 1] === '/') navigate(-1);
  else navigate('/', { replace: true, state: TAB_ENTRY });
};
