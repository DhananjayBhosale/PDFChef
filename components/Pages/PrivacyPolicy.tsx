import React from 'react';
import { Link } from 'react-router-dom';
import { Info, Shield } from 'lucide-react';

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="space-y-3">
    <h2 className="text-xl font-bold text-slate-900 dark:text-white">{title}</h2>
    <div className="space-y-3 text-slate-700 dark:text-slate-300">{children}</div>
  </section>
);

export const PrivacyPolicy: React.FC = () => {
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">


      <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <header className="border-b border-slate-200 bg-slate-50 px-4 py-6 sm:px-8 sm:py-10 dark:border-slate-800 dark:bg-slate-800/50">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]">
              <Shield aria-hidden size={24} />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-slate-900 dark:text-white">Privacy Policy</h1>
              <p className="mt-2 text-slate-500 dark:text-slate-400">Effective Date: June 13, 2026</p>
            </div>
          </div>
        </header>

        <div className="chef-privacy-summary border-b border-[var(--border-hairline)] bg-[var(--accent-quiet)] px-4 py-5 sm:px-8 sm:py-6">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-bold text-[var(--accent-on-quiet)]">
            <Info aria-hidden size={18} />
            Summary
          </h2>
          <div className="space-y-3 text-sm leading-6 text-[var(--text-primary)]">
            <p>
              PDF Chef processes documents locally on your device. We do not upload your PDFs, images,
              signatures, passwords, or generated files to PDF Chef servers for processing.
            </p>
            <p>
              The Android and iOS apps do not require an account and do not show third-party ads. The
              current Android build includes no analytics or crash-reporting SDKs, and the iOS privacy
              manifest declares no tracking and no collected data.
            </p>
            <p>
              Network access exists only for Google Play in-app updates and Google Play services scanner
              support on Android, normal website delivery on the web, and any link you choose to open in a
              browser. Core processing on iOS does not require a server.
            </p>
          </div>
        </div>

        <div className="space-y-6 px-4 py-6 leading-7 sm:space-y-8 sm:px-8 sm:py-10">
          <Section title="1. Who We Are">
            <p>
              PDF Chef is provided by Dhananjay Tech. This Privacy Policy applies to the PDF Chef Android
              app, the PDF Chef iOS app, and the PDF Chef website at pdfchef.dhananjaytech.app.
            </p>
          </Section>

          <Section title="2. Information We Collect">
            <p>
              We do not require you to create an account, and we do not collect your name, email address,
              document contents, signatures, passwords, or other direct personal identifiers through the
              PDF Chef Android or iOS apps.
            </p>
            <p>
              The website is hosted on Cloudflare Pages. Cloudflare may process standard request
              information, such as IP address, user agent, and request URL, to deliver and secure the
              website. This hosting information is not used by PDF Chef to identify you or profile your
              document activity.
            </p>
          </Section>

          <Section title="3. Local Document Processing">
            <p>
              Core PDF operations, including merge, split, compress, sign, protect, unlock, convert,
              watermark, page numbering, repair, and text extraction, run on your device. Your selected
              files remain under your control and are not sent to a PDF Chef server.
            </p>
            <p>
              Generated files are saved where you choose to save them, or in the app's local storage until
              you export or delete them.
            </p>
          </Section>

          <Section title="4. App Permissions">
            <p>PDF Chef requests permissions only when needed for app features:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <strong>Files and media:</strong> used to select PDFs or images and save processed output.
              </li>
              <li>
                <strong>Camera or document scanner:</strong> requested only when you tap Scan from Camera to
                scan paper documents into a PDF.
              </li>
              <li>
                <strong>Internet and network state (Android):</strong> used for Google Play in-app updates and
                Google Play services scanner support. PDF Chef does not use this permission to upload your
                documents to our servers.
              </li>
            </ul>
          </Section>

          <Section title="5. Third-Party Services">
            <p>These Google services are used on Android only, to provide platform features:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <strong>Google Play Core:</strong> used to check for and install app updates through Google Play.
              </li>
              <li>
                <strong>Google Play services document scanner:</strong> used to support document scanning on
                compatible devices.
              </li>
            </ul>
            <p>
              These services are governed by Google's own terms and privacy policies. PDF Chef does not
              receive your document contents from these services. The iOS app and the web app do not use
              them.
            </p>
          </Section>

          <Section title="6. Analytics, Ads, and Tracking">
            <p>
              The current PDF Chef Android app does not include third-party advertising, analytics, or
              crash-reporting SDKs. The iOS privacy manifest declares no tracking and no collected data. The
              website does not use tracking cookies in the current build.
            </p>
          </Section>

          <Section title="7. Data Sharing">
            <p>
              We do not sell your personal data. We do not share your documents, images, passwords, or
              signatures because PDF Chef does not collect them for server-side processing.
            </p>
          </Section>

          <Section title="8. Data Retention">
            <p>
              Because PDF Chef does not upload your documents to a PDF Chef server, we do not retain your
              documents on our servers. Files you create or export remain on your device until you delete
              them or remove app data.
            </p>
          </Section>

          <Section title="9. Children's Privacy">
            <p>
              PDF Chef is a general document utility and is not directed at children under 13. We do not
              knowingly collect personal information from children.
            </p>
          </Section>

          <Section title="10. Security">
            <p>
              Local processing reduces the risk of document exposure through server uploads. You are still
              responsible for securing your device and keeping sensitive exported files and PDF passwords safe.
            </p>
          </Section>

          <Section title="11. Changes to This Policy">
            <p>
              We may update this policy when app features, platform requirements, or legal requirements
              change. The effective date above will be updated when we publish a material change.
            </p>
          </Section>

          <Section title="12. Contact">
            <p>
              Questions about this Privacy Policy can be sent to{' '}
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
            <Link to="/terms" className="chef-target inline-flex items-center font-medium text-[var(--accent-text)] underline underline-offset-2 hover:text-[var(--accent-hover)]">
              Read Terms and Conditions
            </Link>
          </div>
        </div>
      </article>
    </div>
  );
};
