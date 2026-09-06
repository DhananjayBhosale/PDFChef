import React, { useEffect, useMemo } from 'react';
import { ChevronDown } from 'lucide-react';

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
    title: 'Privacy',
    entries: [
      {
        question: 'Are my files uploaded anywhere?',
        answer:
          'No. Every PDF tool here runs in your browser. Your files stay on your device and are never sent to a server.',
      },
      {
        question: 'Does it work offline?',
        answer: 'Yes. Once the app has loaded, you can turn off your connection and keep working.',
      },
      {
        question: 'Is it free?',
        answer: 'Yes. No accounts, no watermarks, no subscription.',
      },
    ],
  },
  {
    title: 'Compress',
    entries: [
      {
        question: 'Does compressing reduce quality?',
        answer:
          'Not by default. Pages and selectable text stay intact. Turning pages into images shrinks more but is lossy, and the preview shows you the result before you save.',
      },
      {
        question: 'Why did nothing get smaller?',
        answer: 'The PDF was already optimised. Your original is kept rather than replaced with a larger copy.',
      },
      {
        question: 'Why do text-heavy PDFs shrink less?',
        answer:
          'Most of their size is text and fonts, which compress poorly. Images are where the savings are.',
      },
    ],
  },
  {
    title: 'Merge and split',
    entries: [
      {
        question: 'How many PDFs can I merge at once?',
        answer: 'There is no fixed limit. 20–30 typical files work smoothly on most devices.',
      },
      {
        question: 'Can I pull out just a few pages?',
        answer: 'Yes. Select the pages you want in Split and extract them into one new PDF.',
      },
      {
        question: 'Is there a size limit?',
        answer: 'No fixed limit. Very large documents depend on your device memory, because processing is local.',
      },
    ],
  },
  {
    title: 'Devices',
    entries: [
      {
        question: 'Which browsers and devices work?',
        answer: 'Any modern browser on desktop or mobile, plus the Android and iOS apps.',
      },
      {
        question: 'Where do my results go?',
        answer: 'To Recent, where you can reopen, rename, share or save them.',
      },
    ],
  },
];

const HelpRow: React.FC<{ entry: HelpEntry }> = ({ entry }) => {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((current) => !current)}
        className="chef-target chef-pressable-row flex w-full items-center justify-between gap-3 px-4 text-left"
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
    [],
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
        <h1 className="mb-2 text-3xl font-bold text-[var(--text-primary)]">Help</h1>
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
