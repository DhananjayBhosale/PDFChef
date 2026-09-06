import React from 'react';
import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="space-y-3">
    <h2 className="text-xl font-bold text-slate-900 dark:text-white">{title}</h2>
    <div className="space-y-3 text-slate-700 dark:text-slate-300">{children}</div>
  </section>
);

export const TermsConditions: React.FC = () => {
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">


      <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <header className="border-b border-slate-200 bg-slate-50 px-4 py-6 sm:px-8 sm:py-10 dark:border-slate-800 dark:bg-slate-800/50">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]">
              <FileText size={24} />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-slate-900 dark:text-white">Terms and Conditions</h1>
              <p className="mt-2 text-slate-500 dark:text-slate-400">Effective Date: June 13, 2026</p>
            </div>
          </div>
        </header>

        <div className="space-y-6 px-4 py-6 leading-7 sm:space-y-8 sm:px-8 sm:py-10">
          <Section title="1. Acceptance of Terms">
            <p>
              These Terms and Conditions apply to your use of the PDF Chef Android app, the PDF Chef iOS
              app, and the PDF Chef website at pdfchef.dhananjaytech.app. By using PDF Chef, you agree to
              these terms.
            </p>
          </Section>

          <Section title="2. What PDF Chef Provides">
            <p>
              PDF Chef provides tools for common PDF and document workflows, including merging, splitting,
              compressing, converting, signing, protecting, unlocking, watermarking, adding page numbers,
              repairing, and extracting text.
            </p>
            <p>
              Most document operations are performed locally on your device or in your browser. On Android,
              some platform features use network access, such as Google Play in-app updates and Google Play
              services scanner support. Core processing on iOS does not require a server, and links you choose
              to open may launch a browser.
            </p>
          </Section>

          <Section title="3. Your Responsibilities">
            <p>You are responsible for:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li>Using PDF Chef only for lawful purposes.</li>
              <li>Making sure you have the right to process any document you select.</li>
              <li>Reviewing generated files before sharing or relying on them.</li>
              <li>Keeping sensitive files, exported documents, and PDF passwords safe.</li>
              <li>Keeping backups of important documents before editing or converting them.</li>
            </ul>
          </Section>

          <Section title="4. Local Processing and File Handling">
            <p>
              PDF Chef is designed around local document processing. Your files remain under your control.
              We do not provide a backup or recovery service for documents you edit, export, delete, or lose.
            </p>
            <p>
              If you password-protect a PDF and forget the password, PDF Chef cannot recover it for you.
            </p>
          </Section>

          <Section title="5. No Professional Advice">
            <p>
              PDF Chef is a document utility. It does not provide legal, financial, compliance, or professional
              advice. You should review final documents yourself or with a qualified professional when accuracy
              or compliance matters.
            </p>
          </Section>

          <Section title="6. Third-Party Services">
            <p>
              On Android, PDF Chef may rely on Google Play Core for updates and Google Play services for
              document scanning support. The website is hosted on Cloudflare Pages. These services are governed
              by their own terms and policies.
            </p>
          </Section>

          <Section title="7. Availability and Updates">
            <p>
              We may update, change, suspend, or discontinue parts of PDF Chef at any time. Features can vary
              by platform, Android or iOS version, browser support, device capability, and third-party
              service availability.
            </p>
          </Section>

          <Section title="8. Intellectual Property">
            <p>
              PDF Chef, its branding, interface, and related materials belong to Dhananjay Tech or its licensors.
              You retain ownership of your own documents and content.
            </p>
          </Section>

          <Section title="9. Disclaimer">
            <p>
              PDF Chef is provided as is and as available. We do not guarantee that every PDF operation will be
              error-free, preserve every formatting detail, or work with every damaged, encrypted, malformed, or
              unusually structured document.
            </p>
          </Section>

          <Section title="10. Limitation of Liability">
            <p>
              To the fullest extent permitted by law, PDF Chef and Dhananjay Tech are not liable for indirect,
              incidental, special, consequential, or punitive damages, including loss of data, documents,
              passwords, profits, or business opportunities arising from your use of PDF Chef.
            </p>
          </Section>

          <Section title="11. Changes to These Terms">
            <p>
              We may update these terms from time to time. The effective date above will be updated when we
              publish material changes.
            </p>
          </Section>

          <Section title="12. Contact">
            <p>
              Questions about these Terms and Conditions can be sent to{' '}
              <a className="font-medium text-[var(--accent-text)] underline underline-offset-2 hover:text-[var(--accent-hover)]" href="mailto:yt.dhananjay@gmail.com">
                yt.dhananjay@gmail.com
              </a>
              .
            </p>
            <p>
              Developer: Dhananjay Tech
              <br />
              Website: https://pdfchef.dhananjaytech.app/
            </p>
          </Section>

          <div className="border-t border-slate-200 pt-8 dark:border-slate-800">
            <Link to="/privacy" className="chef-target inline-flex items-center font-medium text-[var(--accent-text)] underline underline-offset-2 hover:text-[var(--accent-hover)]">
              Read Privacy Policy
            </Link>
          </div>
        </div>
      </article>
    </div>
  );
};
