import { LegalTranslationNotice } from '../UI/LegalTranslationNotice';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React from 'react';
import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => { useI18n(); return (
  <section className="space-y-3">
    <h2 className="text-xl font-bold text-slate-900 dark:text-white">{title}</h2>
    <div className="space-y-3 text-slate-700 dark:text-slate-300">{children}</div>
  </section>
); };

export const TermsConditions: React.FC = () => {
  useI18n();
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">


      <LegalTranslationNotice />
      <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <header className="border-b border-slate-200 bg-slate-50 px-4 py-6 sm:px-8 sm:py-10 dark:border-slate-800 dark:bg-slate-800/50">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]">
              <FileText size={24} />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-slate-900 dark:text-white">{t("terms-conditions.terms.and.conditions.34e6fa")}</h1>
              <p className="mt-2 text-slate-500 dark:text-slate-400">{t("terms-conditions.effective.date.september.13.2026.3614b6")}</p>
            </div>
          </div>
        </header>

        <div className="space-y-6 px-4 py-6 leading-7 sm:space-y-8 sm:px-8 sm:py-10">
          <Section title={t("terms-conditions.1.acceptance.of.terms.5cf3cf")}>
            <p>{t("terms-conditions.these.terms.and.conditions.apply.to.your.0c1773")}</p>
          </Section>

          <Section title={t("terms-conditions.2.what.pdf.chef.provides.cc2400")}>
            <p>{t("terms-conditions.pdf.chef.provides.tools.for.common.pdf.34b4ec")}</p>
            <p>{t("terms-conditions.most.document.operations.are.performed.locally.on.c66c10")}</p>
          </Section>

          <Section title={t("terms-conditions.3.your.responsibilities.e19ea7")}>
            <p>{t("terms-conditions.you.are.responsible.for.bfaa69")}</p>
            <ul className="list-disc space-y-2 ps-6">
              <li>{t("terms-conditions.using.pdf.chef.only.for.lawful.purposes.714ccf")}</li>
              <li>{t("terms-conditions.making.sure.you.have.the.right.to.aca742")}</li>
              <li>{t("terms-conditions.reviewing.generated.files.before.sharing.or.relying.9bc216")}</li>
              <li>{t("terms-conditions.keeping.sensitive.files.exported.documents.and.pdf.4b0c97")}</li>
              <li>{t("terms-conditions.keeping.backups.of.important.documents.before.editing.276eb6")}</li>
            </ul>
          </Section>

          <Section title={t("terms-conditions.4.local.processing.and.file.handling.5bcf1b")}>
            <p>{t("terms-conditions.pdf.chef.is.designed.around.local.document.29bc92")}</p>
            <p>{t("terms-conditions.if.you.password.protect.a.pdf.and.fe247c")}</p>
          </Section>

          <Section title={t("terms-conditions.5.no.professional.advice.ee67ff")}>
            <p>{t("terms-conditions.pdf.chef.is.a.document.utility.it.087472")}</p>
          </Section>

          <Section title={t("terms-conditions.6.third.party.services.8f0487")}>
            <p>{t("terms-conditions.on.android.pdf.chef.may.rely.on.e8221e")}</p>
            <p>{t("terms-conditions.on.ios.pro.lifetime.and.pro.monthly.3c75e6")}</p>
            <p>{t("terms-conditions.restore.purchases.is.available.in.settings.and.e310a9")}</p>
          </Section>

          <Section title={t("terms-conditions.7.availability.and.updates.f10d9c")}>
            <p>{t("terms-conditions.we.may.update.change.suspend.or.discontinue.f7dac9")}</p>
          </Section>

          <Section title={t("terms-conditions.8.intellectual.property.9954f6")}>
            <p>{t("terms-conditions.pdf.chef.its.branding.interface.and.related.0ed7ec")}</p>
          </Section>

          <Section title={t("terms-conditions.9.disclaimer.a979e3")}>
            <p>{t("terms-conditions.pdf.chef.is.provided.as.is.and.1efa80")}</p>
          </Section>

          <Section title={t("terms-conditions.10.limitation.of.liability.49eeae")}>
            <p>{t("terms-conditions.to.the.fullest.extent.permitted.by.law.3be2aa")}</p>
          </Section>

          <Section title={t("terms-conditions.11.changes.to.these.terms.db40bb")}>
            <p>{t("terms-conditions.we.may.update.these.terms.from.time.e8e9c1")}</p>
          </Section>

          <Section title={t("terms-conditions.12.contact.5adadc")}>
            <p>{t("terms-conditions.questions.about.these.terms.and.conditions.can.c056ec")}{' '}
              <a className="font-medium text-[var(--accent-text)] underline underline-offset-2 hover:text-[var(--accent-hover)]" href="mailto:yt.dhananjay@gmail.com">{t("terms-conditions.yt.dhananjay.gmail.com.b7a748")}</a>
              .
            </p>
            <p>{t("terms-conditions.developer.dhananjay.tech.343a7a")}<br />{t("terms-conditions.website.https.pdfchef.dhananjaytech.app.a7a8b0")}</p>
          </Section>

          <div className="border-t border-slate-200 pt-8 dark:border-slate-800">
            <Link to="/privacy" className="chef-target inline-flex items-center font-medium text-[var(--accent-text)] underline underline-offset-2 hover:text-[var(--accent-hover)]">{t("terms-conditions.read.privacy.policy.b916b0")}</Link>
          </div>
        </div>
      </article>
    </div>
  );
};
