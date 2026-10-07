import { useSyncExternalStore } from 'react';
import { getLocale, getLocalePreference, getLocaleRevision, subscribeLocale, t } from './core';
/** Subscribe only components that render localized copy; changing language never remounts an editor. */
export function useI18n() {
  const revision = useSyncExternalStore(subscribeLocale, getLocaleRevision, getLocaleRevision);
  return { t, locale: getLocale(), preference: getLocalePreference(), revision };
}
