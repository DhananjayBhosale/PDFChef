import React from 'react';
import { Download } from 'lucide-react';
import { t } from '../../services/i18n/core';
import { useI18n } from '../../services/i18n/react';
import { mobileAppLinks, type SmartphonePlatform } from '../../services/mobileAppWelcome';
import { Button } from './Primitives';

export const MobileAppWelcome: React.FC<{
  platform: SmartphonePlatform;
  onContinue: () => void;
}> = ({ platform, onContinue }) => {
  useI18n();

  const downloadClass = (target: SmartphonePlatform) => [
    'chef-pressable chef-target flex w-full items-center justify-center gap-3 rounded-[var(--radius-control)] border px-4 py-4 text-sm font-semibold',
    platform === target
      ? 'border-transparent bg-[var(--accent-rest)] text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)]'
      : 'border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text-primary)] hover:border-[var(--accent-rest)]',
  ].join(' ');

  return (
    <main
      id="main"
      data-testid="mobile-app-welcome"
      className="chef-safe-x flex min-h-[100dvh] flex-col items-center justify-center bg-[var(--surface-canvas)] px-6 text-center text-[var(--text-primary)]"
      style={{ paddingTop: 'max(2rem, env(safe-area-inset-top))', paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
    >
      <div className="w-full max-w-sm">
        <img src="/pdf-chef-logo-exact.webp" alt="" aria-hidden className="mx-auto h-20 w-20 object-contain" />
        <p className="mt-3 text-sm font-semibold">PDF Chef</p>
        <h1 className="type-title1 mt-8 text-3xl font-semibold">{t("mobileAppWelcome.title")}</h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">{t("mobileAppWelcome.description")}</p>

        <div className="mt-8 space-y-3">
          <a href={mobileAppLinks.android} className={downloadClass('android')}>
            <Download size={20} aria-hidden className="shrink-0" />
            <span className="chef-wrap-words">{t("mobileAppWelcome.android")}</span>
          </a>
          <a href={mobileAppLinks.ios} className={downloadClass('ios')}>
            <Download size={20} aria-hidden className="shrink-0" />
            <span className="chef-wrap-words">{t("mobileAppWelcome.ios")}</span>
          </a>
          <Button block onClick={onContinue} className="min-h-12">{t("mobileAppWelcome.visitWebsite")}</Button>
        </div>

        <button
          type="button"
          onClick={onContinue}
          className="chef-pressable chef-target mt-6 rounded-[var(--radius-control)] px-4 text-xs text-[var(--text-secondary)] hover:underline"
        >{t("mobileAppWelcome.skip")}</button>
      </div>
    </main>
  );
};
