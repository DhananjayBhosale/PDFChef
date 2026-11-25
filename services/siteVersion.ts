/**
 * The website serves the old and the new version side by side (owner, 25 Nov 2026). The server
 * (functions/_middleware.js) picks one by a cookie and marks the page with
 * <meta name="pdfchef-version-switch">; without that mark (the apps, a local preview) there is no
 * switch. A switch is a full page load through /__version/<old|new>, which sets the cookie.
 */
export type SiteVersion = 'old' | 'new';

export const siteVersionSwitchAvailable = (): boolean =>
  typeof document !== 'undefined' && document.querySelector('meta[name="pdfchef-version-switch"]') !== null;

/** Only a path on this site: "/merge?x" stays, anything else goes Home. */
export const siteVersionUrl = (version: SiteVersion, path: string): string =>
  `/__version/${version}?to=${encodeURIComponent(/^\/(?!\/)/.test(path) ? path : '/')}`;
