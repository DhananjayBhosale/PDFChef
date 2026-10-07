import { LegalTranslationNotice } from '../UI/LegalTranslationNotice';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React from 'react';
import { Link } from 'react-router-dom';
import { Info, Shield } from 'lucide-react';

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => { useI18n(); return (
  <section className="space-y-3">
    <h2 className="text-xl font-bold text-slate-900 dark:text-white">{title}</h2>
    <div className="space-y-3 text-slate-700 dark:text-slate-300">{children}</div>
  </section>
); };

export const PrivacyPolicy: React.FC = () => {
  useI18n();
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">


      <LegalTranslationNotice />
      <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <header className="border-b border-slate-200 bg-slate-50 px-4 py-6 sm:px-8 sm:py-10 dark:border-slate-800 dark:bg-slate-800/50">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]">
              <Shield aria-hidden size={24} />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-slate-900 dark:text-white">{t("privacy-policy.privacy.policy.506ff3")}</h1>
              <p className="mt-2 text-slate-500 dark:text-slate-400">{t("privacy-policy.effective.date.september.13.2026.3614b6")}</p>
            </div>
          </div>
        </header>

        <div className="chef-privacy-summary border-b border-[var(--border-hairline)] bg-[var(--accent-quiet)] px-4 py-5 sm:px-8 sm:py-6">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-bold text-[var(--accent-on-quiet)]">
            <Info aria-hidden size={18} />{t("privacy-policy.summary.8e76a9")}</h2>
          <div className="space-y-3 text-sm leading-6 text-[var(--text-primary)]">
            <p>{t("privacy-policy.pdf.chef.processes.documents.locally.on.your.bab7de")}</p>
            <p>{t("privacy-policy.the.android.and.ios.apps.do.not.5b978c")}</p>
            <p>{t("privacy-policy.network.access.exists.only.for.google.play.5726b5")}</p>
          </div>
        </div>

        <div className="space-y-6 px-4 py-6 leading-7 sm:space-y-8 sm:px-8 sm:py-10">
          <Section title={t("privacy-policy.1.who.we.are.78bb62")}>
            <p>{t("privacy-policy.pdf.chef.is.provided.by.dhananjay.tech.cbfd48")}</p>
          </Section>

          <Section title={t("privacy-policy.2.information.we.collect.1c9c7f")}>
            <p>{t("privacy-policy.we.do.not.require.you.to.create.4314dc")}</p>
            <p>{t("privacy-policy.the.website.is.hosted.on.cloudflare.pages.493b0e")}</p>
          </Section>

          <Section title={t("privacy-policy.3.local.document.processing.71628d")}>
            <p>{t("privacy-policy.core.pdf.operations.including.merge.split.compress.5b2f70")}</p>
            <p>{t("privacy-policy.eligible.generated.files.are.saved.where.you.ff6a37")}</p>
          </Section>

          <Section title={t("privacy-policy.4.app.permissions.4b1ed9")}>
            <p>{t("privacy-policy.pdf.chef.requests.permissions.only.when.needed.3b92eb")}</p>
            <ul className="list-disc space-y-2 ps-6">
              <li>
                <strong>{t("privacy-policy.files.and.media.466b44")}</strong>{t("privacy-policy.used.to.select.pdfs.or.images.and.2b7ccd")}</li>
              <li>
                <strong>{t("privacy-policy.camera.or.document.scanner.3d4bad")}</strong>{t("privacy-policy.requested.only.when.you.tap.scan.from.9d7559")}</li>
              <li>
                <strong>{t("privacy-policy.internet.and.network.state.android.1c31f1")}</strong>{t("privacy-policy.used.for.google.play.in.app.updates.35b7ed")}</li>
            </ul>
          </Section>

          <Section title={t("privacy-policy.5.third.party.services.e951fb")}>
            <p>{t("privacy-policy.these.google.services.are.used.on.android.546908")}</p>
            <ul className="list-disc space-y-2 ps-6">
              <li>
                <strong>{t("privacy-policy.google.play.core.a4cac7")}</strong>{t("privacy-policy.used.to.check.for.and.install.app.b28488")}</li>
              <li>
                <strong>{t("privacy-policy.google.play.services.document.scanner.486603")}</strong>{t("privacy-policy.used.to.support.document.scanning.on.compatible.bbdb6d")}</li>
            </ul>
            <p>{t("privacy-policy.these.services.are.governed.by.google.s.976d0b")}</p>
            <p>{t("privacy-policy.the.ios.app.uses.apple.app.store.3f45a7")}</p>
          </Section>

          <Section title={t("privacy-policy.6.analytics.ads.and.tracking.f2440c")}>
            <p>{t("privacy-policy.the.current.pdf.chef.android.app.does.d458e9")}</p>
          </Section>

          <Section title={t("privacy-policy.7.data.sharing.dff03f")}>
            <p>{t("privacy-policy.we.do.not.sell.your.personal.data.b3788b")}</p>
          </Section>

          <Section title={t("privacy-policy.8.data.retention.30d684")}>
            <p>{t("privacy-policy.because.pdf.chef.does.not.upload.your.36e949")}</p>
          </Section>

          <Section title={t("privacy-policy.9.children.s.privacy.8f6eea")}>
            <p>{t("privacy-policy.pdf.chef.is.a.general.document.utility.164152")}</p>
          </Section>

          <Section title={t("privacy-policy.10.security.67a398")}>
            <p>{t("privacy-policy.local.processing.reduces.the.risk.of.document.a0a3a6")}</p>
          </Section>

          <Section title={t("privacy-policy.11.changes.to.this.policy.783b81")}>
            <p>{t("privacy-policy.we.may.update.this.policy.when.app.3af883")}</p>
          </Section>

          <Section title={t("privacy-policy.12.contact.5adadc")}>
            <p>{t("privacy-policy.questions.about.this.privacy.policy.can.be.5978f6")}{' '}
              <a className="font-medium text-[var(--accent-text)] underline underline-offset-2 hover:text-[var(--accent-hover)]" href="mailto:yt.dhananjay@gmail.com">{t("privacy-policy.yt.dhananjay.gmail.com.b7a748")}</a>
              .
            </p>
            <p>{t("privacy-policy.developer.dhananjay.tech.343a7a")}<br />{t("privacy-policy.website.https.pdfchef.dhananjaytech.app.a7a8b0")}</p>
          </Section>

          <div className="border-t border-slate-200 pt-8 dark:border-slate-800">
            <Link to="/terms" className="chef-target inline-flex items-center font-medium text-[var(--accent-text)] underline underline-offset-2 hover:text-[var(--accent-hover)]">{t("privacy-policy.read.terms.and.conditions.586b2e")}</Link>
          </div>
        </div>
      </article>
    </div>
  );
};
