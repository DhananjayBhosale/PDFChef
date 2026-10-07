import React, { useEffect, useRef } from 'react';
import { useI18n } from '../../services/i18n/react';
import { getLocalePreference, setLocalePreference, setTemporaryLocale } from '../../services/i18n/core.ts';
/** Legal translations remain advisory until professionally reviewed. */
export const LegalTranslationNotice: React.FC = () => {
  const { t, locale } = useI18n();
  const showingEnglish = useRef(false);
  useEffect(() => () => {
    if (showingEnglish.current) {
      void setLocalePreference(getLocalePreference(), false).catch(() => {});
    }
  }, []);
  if (locale.startsWith('en-')) return null;
  return <aside className="mb-4 rounded border border-[var(--border-strong)] p-3 text-sm" role="note">
    <p>{t('legal.translationNotice')}</p>
    <button type="button" className="chef-target mt-1 font-semibold underline"
      onClick={() => { showingEnglish.current = true; void setTemporaryLocale('en-US'); }}>
      {t('legal.englishVersion')}
    </button>
  </aside>;
};
