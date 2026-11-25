export type SmartphonePlatform = 'android' | 'ios';

export const mobileAppLinks = {
  android: 'https://play.google.com/store/apps/details?id=com.dhananjaytech.pdfchef',
  ios: 'https://apps.apple.com/app/pdf-chef/id6811619417',
} as const;

export const mobileAppWelcomeDismissedKey = 'pdfchef.mobile-app-welcome.dismissed.v1';
/** This browser session's answer ('shown' or 'skipped'), so a reload keeps it. */
export const mobileAppWelcomeSessionKey = 'pdfchef.mobile-app-welcome.session.v1';
/** The last session's answer, kept across sessions. */
export const mobileAppWelcomeLastKey = 'pdfchef.mobile-app-welcome.last.v1';

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Every other browser session on a phone, starting with the first (owner, 25 Nov 2026): a
 * session that showed the screen is followed by one that does not. Without session storage it shows.
 */
export function welcomeThisSession(session: KeyValueStore | null, local: KeyValueStore | null): boolean {
  const read = (store: KeyValueStore | null, key: string) => { try { return store?.getItem(key) ?? null; } catch { return null; } };
  const write = (store: KeyValueStore | null, key: string, value: string) => { try { store?.setItem(key, value); } catch { /* in memory only */ } };
  if (read(session, mobileAppWelcomeDismissedKey) === 'true') return false;
  const decided = read(session, mobileAppWelcomeSessionKey);
  if (decided) return decided === 'shown';
  const show = read(local, mobileAppWelcomeLastKey) !== 'shown';
  const answer = show ? 'shown' : 'skipped';
  // No session storage, no sessions to count: every page load would flip the answer.
  try {
    if (!session) return true;
    session.setItem(mobileAppWelcomeSessionKey, answer);
  } catch { return true; }
  write(local, mobileAppWelcomeLastKey, answer);
  return show;
}

/** Phone browsers only. Tablets and the installed apps keep their normal entry. */
export function smartphonePlatform(userAgent: string, nativePlatform: string, origin: string): SmartphonePlatform | null {
  if (nativePlatform !== 'web' || origin === 'https://localhost' || origin.startsWith('capacitor://')) return null;
  if (/iPad/i.test(userAgent)) return null;
  if (/iPhone|iPod/i.test(userAgent)) return 'ios';
  if (/Android/i.test(userAgent) && /Mobile/i.test(userAgent)) return 'android';
  return null;
}

/** Store reviewers and readers can open legal links directly. */
export function isMobileAppWelcomeRoute(pathname: string): boolean {
  return !['/privacy', '/privacy-policy', '/pdf-chef-privacy', '/terms', '/terms-and-conditions'].includes(pathname.replace(/\/$/, '') || '/');
}
