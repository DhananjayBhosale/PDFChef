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
  /** `js` npm package, `asset` bundled data or embedded library, `android` Gradle library, `ios` Swift package. */
  kind: 'js' | 'asset' | 'android' | 'ios';
  /** Set on bundled data that only one platform's app ships. */
  platform?: 'android' | 'ios';
  /** SPDX expression of the terms the app uses the component under. */
  license: string;
  copyright: string;
  url: string;
  note?: string;
}

export interface LicenseTexts {
  licenses: Record<string, { name: string; text: string }>;
  /** `kind` is set on a NOTICE that only one platform's native build ships. */
  notices: Array<{ component: string; title: string; text: string; kind?: ThirdPartyComponent['kind'] }>;
}

export const thirdPartyComponents = componentData as ThirdPartyComponent[];

/** Each app lists its own native libraries and not the other platform's; the website lists everything. */
export const shownOnPlatform = (platform: string, kind: ThirdPartyComponent['kind'] | undefined): boolean =>
  !((platform === 'ios' && kind === 'android') || (platform === 'android' && kind === 'ios'));

export const componentsForPlatform = (platform: string): ThirdPartyComponent[] =>
  thirdPartyComponents.filter((item) => shownOnPlatform(platform, item.platform ?? item.kind));

/** The licence ids named by an SPDX-style expression such as "Apache-2.0 AND BSD-3-Clause". */
export const licenseIds = (expression: string): string[] => expression.split(/\s+(?:AND|OR|WITH)\s+/);

/** The licence texts are large, so they load as their own chunk when the page asks. */
export const loadLicenseTexts = (): Promise<LicenseTexts> =>
  import('./licenseTexts.json').then((module) => module.default as LicenseTexts);
