import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import { Capacitor } from '@capacitor/core';

// Android saves to a known folder and has a fixed file limit, so its answers say so.
const isAndroid = () => Capacitor.getPlatform() === 'android';

/**
 * Every answer the product used to bury under a "Help" toggle at the foot of
 * three tool pages, in one place a user can choose to visit. A tool screen is
 * for doing the thing; nobody reads an FAQ mid-task.
 */

interface HelpEntry {
  question: string;
  answer: string;
}

interface HelpSection {
  title: string;
  entries: HelpEntry[];
}

const SECTIONS: HelpSection[] = [
  {
    get title() { return t("help-page.privacy.54a57c"); },
    entries: [
      {
        get question() { return t("help-page.are.my.files.uploaded.anywhere.7de2be"); },
        get answer() { return t("help-page.no.pdf.chef.processes.documents.locally.on.9a3877"); },
      },
      {
        get question() { return t("help-page.does.it.work.offline.78cd63"); },
        get answer() { return t("help-page.yes.once.the.app.has.loaded.you.dfe0ec"); },
      },
      {
        get question() { return t("help-page.is.it.free.7085af"); },
        get answer() { return t("help-page.processing.is.unlimited.on.ios.the.first.90908e"); },
      },
    ],
  },
  {
    get title() { return t("help-page.compress.033fc0"); },
    entries: [
      {
        get question() { return t("help-page.does.compressing.reduce.quality.d4dbef"); },
        get answer() { return t("help-page.not.by.default.pages.and.selectable.text.058c9f"); },
      },
      {
        get question() { return t("help-page.why.did.nothing.get.smaller.44c1a7"); },
        get answer() { return t("help-page.the.pdf.was.already.optimised.your.original.223457"); },
      },
      {
        get question() { return t("help-page.why.do.text.heavy.pdfs.shrink.less.78a1db"); },
        get answer() { return t("help-page.most.of.their.size.is.text.and.807643"); },
      },
    ],
  },
  {
    get title() { return t("help-page.merge.and.split.96ed58"); },
    entries: [
      {
        get question() { return t("help-page.how.many.pdfs.can.i.merge.at.4c713a"); },
        get answer() { return t("help-page.there.is.no.fixed.limit.20.30.b20788"); },
      },
      {
        get question() { return t("help-page.can.i.pull.out.just.a.few.277367"); },
        get answer() { return t("help-page.yes.select.the.pages.you.want.in.273280"); },
      },
      {
        get question() { return t("help-page.is.there.a.size.limit.3e263d"); },
        get answer() {
          return isAndroid()
            ? t("help-page.on.android.pdf.chef.can.open.and.923a4e")
            : t("help-page.no.fixed.limit.very.large.documents.depend.4a99dd");
        },
      },
    ],
  },
  {
    get title() { return t("help-page.devices.4ba512"); },
    entries: [
      {
        get question() { return t("help-page.which.browsers.and.devices.work.a421cc"); },
        get answer() { return t("help-page.any.modern.browser.on.desktop.or.mobile.733cb2"); },
      },
      {
        get question() { return t("help-page.where.do.my.results.go.fe9700"); },
        get answer() {
          return isAndroid()
            ? t("help-page.on.android.results.are.saved.in.5d9a54", {
              v0: 'Download/PDF Chef',
              v1: t("settings-page.download.automatically.when.a.job.finishes.dcf3b4"),
              v2: t("settings-page.keep.results.in.recent.bf522d"),
            })
            : t("help-page.successful.results.you.can.export.are.kept.db8b0a");
        },
      },
    ],
  },
];

const HelpRow: React.FC<{ entry: HelpEntry }> = ({ entry }) => {
  useI18n();
  const [open, setOpen] = React.useState(false);
  const id = React.useId();

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((current) => !current)}
        className="chef-target chef-pressable-row flex w-full items-center justify-between gap-3 px-4 text-start"
      >
        <span className="min-w-0 font-semibold text-[var(--text-primary)]">{entry.question}</span>
        <ChevronDown
          aria-hidden
          size={18}
          className={`shrink-0 text-[var(--text-secondary)] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <p id={id} className="max-w-measure px-4 pb-3 text-sm leading-relaxed text-[var(--text-secondary)]">
          {entry.answer}
        </p>
      )}
    </div>
  );
};

/*
 * Title, description and canonical for this route live in
 * `components/SEO/RouteSEO.tsx` and `functions/_middleware.js`, which are the
 * only two writers of page metadata. A page component setting its own would put
 * a second writer on the same DOM nodes, and the last effect to run would win.
 */
export const HelpPage: React.FC = () => {
  const { revision } = useI18n();
  const schema = useMemo(
    () => ({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: SECTIONS.flatMap((section) =>
        section.entries.map((entry) => ({
          '@type': 'Question',
          name: entry.question,
          acceptedAnswer: { '@type': 'Answer', text: entry.answer },
        })),
      ),
    }),
    [revision],
  );

  /**
   * FAQ structured data belongs in `<head>` beside the rest of the metadata, and
   * it has to be removed again on unmount: this is a single-page app, so a tag
   * left behind would keep claiming the next route is an FAQ page. `<` is
   * escaped because a JSON string may legally contain one, and inside a script
   * element that would end the block early.
   */
  useEffect(() => {
    const element = document.createElement('script');
    element.type = 'application/ld+json';
    element.dataset.helpFaq = 'true';
    element.textContent = JSON.stringify(schema).replace(/</g, '\\u003c');
    document.head.appendChild(element);
    return () => {
      element.remove();
    };
  }, [schema]);

  return (
    <>
      <div className="mx-auto w-full max-w-4xl px-4 py-4 pb-10 sm:py-10 md:px-8">
        <h1 className="mb-2 text-3xl font-bold text-[var(--text-primary)]">{t("help-page.help.b79cac")}</h1>
        {SECTIONS.map((section) => (
          <section key={section.title} className="mt-5 first:mt-1">
            <h2 className="type-caption px-4 pb-1 uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
              {section.title}
            </h2>
            <div className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)]">
              {section.entries.map((entry) => (
                <HelpRow key={entry.question} entry={entry} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
};
