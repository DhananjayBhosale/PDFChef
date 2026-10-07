export type SmartphonePlatform = 'android' | 'ios';

export const mobileAppLinks = {
  android: 'https://play.google.com/store/apps/details?id=com.dhananjaytech.pdfchef',
  ios: 'https://apps.apple.com/app/pdf-chef/id6811619417',
} as const;

export const mobileAppWelcomeDismissedKey = 'pdfchef.mobile-app-welcome.dismissed.v1';

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
