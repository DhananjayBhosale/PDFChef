import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { componentsForPlatform, licenseIds, loadLicenseTexts, shownOnPlatform, type LicenseTexts } from '../../services/legal/thirdPartyNotices';

/* Component names, versions, copyright lines and licence texts are the authors' own words and are
   shown as written, in English, whatever the app language is. */

const licenseLabel = (expression: string) => expression.replace(/LicenseRef-/g, '');

const LicenseText: React.FC<{ title: string; text: string }> = ({ title, text }) => (
  <details className="group">
    <summary className="chef-target chef-pressable-row flex cursor-pointer list-none items-center justify-between gap-3 px-4 [&::-webkit-details-marker]:hidden">
      <span className="chef-wrap-words min-w-0 font-semibold text-[var(--text-primary)]">{title}</span>
      <ChevronDown
        aria-hidden
        size={18}
        className="shrink-0 text-[var(--text-secondary)] transition-transform group-open:rotate-180"
      />
    </summary>
    <pre className="whitespace-pre-wrap break-words px-4 pb-4 font-mono text-xs leading-relaxed text-[var(--text-secondary)]">
      {text}
    </pre>
  </details>
);

const platform = Capacitor.getPlatform();
const components = componentsForPlatform(platform);
const shownLicenses = new Set(components.flatMap((item) => licenseIds(item.license)));

const panel =
  'divide-y divide-[var(--border-hairline)] rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)]';

export const OpenSourceLicenses: React.FC = () => {
  useI18n();
  const [texts, setTexts] = useState<LicenseTexts | null>(null);

  useEffect(() => {
    let current = true;
    loadLicenseTexts()
      .then((loaded) => {
        if (current) setTexts(loaded);
      })
      .catch(() => undefined); // The component list above still stands without the texts.
    return () => {
      current = false;
    };
  }, []);

  const title = t("settings-page.open.source.licenses.c9f6d0");
  const notices = texts?.notices.filter((notice) => shownOnPlatform(platform, notice.kind)) ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-4 pb-10 sm:py-10 md:px-8">
      <h1 className="mb-4 text-3xl font-bold text-[var(--text-primary)]">{title}</h1>
      <ul aria-label={title} lang="en" dir="ltr" className={`${panel} px-4`}>
        {components.map((item) => (
          <li key={`${item.kind}:${item.name}@${item.version}`} className="py-2.5">
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="chef-wrap-words font-semibold text-[var(--text-primary)]">{item.name}</span>
              <span className="type-footnote tabular text-[var(--text-secondary)]">{item.version}</span>
              <span className="type-footnote ms-auto font-semibold text-[var(--text-secondary)]">{licenseLabel(item.license)}</span>
            </p>
            <p className="type-footnote chef-wrap-words mt-0.5 text-[var(--text-secondary)]">{item.copyright}</p>
          </li>
        ))}
      </ul>
      {texts && (
        <div lang="en" dir="ltr" className="mt-8 space-y-4">
          <div className={panel}>
            {Object.keys(texts.licenses).filter((id) => shownLicenses.has(id)).map((id) => (
              <LicenseText key={id} title={`${texts.licenses[id].name} (${licenseLabel(id)})`} text={texts.licenses[id].text} />
            ))}
          </div>
          {notices.length > 0 && (
            <div className={panel}>
              {notices.map((notice) => (
                <LicenseText key={notice.component} title={notice.title} text={notice.text} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
