import componentData from './thirdPartyComponents.json';

/**
 * The third-party components PDF Chef ships, as shown on Settings > Open-source
 * licenses. THIRD_PARTY_NOTICES.md is generated from the same two JSON files by
 * `scripts/generate-third-party-notices.mjs`, so the page and the file cannot disagree.
 *
 * Names, versions, copyright lines and licence texts are published as their
 * authors wrote them and are deliberately not translated.
 */
export interface ThirdPartyComponent {
  name: string;
  version: string;
  /** `js` npm package, `asset` bundled data or embedded library, `android` Gradle library. */
  kind: 'js' | 'asset' | 'android';
  /** SPDX expression of the terms the app uses the component under. */
  license: string;
  copyright: string;
  url: string;
  note?: string;
}

export interface LicenseTexts {
  licenses: Record<string, { name: string; text: string }>;
  notices: Array<{ component: string; title: string; text: string }>;
}

export const thirdPartyComponents = componentData as ThirdPartyComponent[];

/** The licence texts are large, so they load as their own chunk when the page asks. */
export const loadLicenseTexts = (): Promise<LicenseTexts> =>
  import('./licenseTexts.json').then((module) => module.default as LicenseTexts);
