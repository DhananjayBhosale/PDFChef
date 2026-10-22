import { localizeError } from '../../services/i18n/errors.ts';
import { t, getLocale, setLocalePreference } from '../../services/i18n/core.ts';
import { locales, type LocalePreference } from '../../services/i18n/locales.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight, ExternalLink } from 'lucide-react';
import { announceRecordsChanged, getWorkspaceSettings, updateWorkspaceSettings, type WorkspaceSettings } from '../../services/workspace';
import { TabHeader } from '../Layout/AppShell';
import { Button, ConfirmSheet, SegmentedControl, StatusLine, Switch, cx } from '../UI/Primitives';
import { formatBytes } from '../UI/format';
import { useMonetization } from '../../hooks/useMonetization';
import { useSupport } from '../../hooks/useSupport';
import { SupportChoices, SupporterBadge } from '../UI/SupportPDFChef';
import {
  TEXT_SCALE_LABELS,
  useAppearance,
  type TextScale,
  type ThemePreference,
  type ThemeSyncState,
} from '../../hooks/useAppearance';
import {
  knownSpaceSaved,
  useApplicationMetadata,
  useRecentRecords,
  useStorageInformation,
  useWorkspacePlatform,
} from '../../hooks/useWorkspaceRuntime';

/* -------------------------------------------------------------- Group --- */

const Group: React.FC<{
  title: string;
  children: React.ReactNode;
}> = ({ title, children }) => { useI18n(); return (
  <section className="mt-5 first:mt-1">
    <h2 className="type-caption px-4 pb-1 uppercase tracking-[0.08em] text-[var(--text-tertiary)]">{title}</h2>
    <div className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] px-4">
      {children}
    </div>
  </section>
); };

const Row: React.FC<{ label?: string; detail?: string; children?: React.ReactNode; stacked?: boolean }> = ({
  label,
  detail,
  children,
  stacked = false,
}) => { useI18n(); return (
  <div className={cx('py-2.5', stacked ? 'space-y-2' : 'flex flex-wrap items-center justify-between gap-3')}>
    <div className={cx('min-w-0', !label && !detail && 'hidden')}>
      {label && <p className="font-semibold text-[var(--text-primary)]">{label}</p>}
      {detail && <p className="type-footnote mt-0.5 max-w-measure text-[var(--text-secondary)]">{detail}</p>}
    </div>
    {children}
  </div>
); };

/* --------------------------------------------------------------- Page --- */

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'system', get label() { return t("settings-page.system.6725e7"); } },
  { value: 'light', get label() { return t("settings-page.light.dbcd5e"); } },
  { value: 'dark', get label() { return t("settings-page.dark.60acc5"); } },
];

const TEXT_SCALE_OPTIONS: ReadonlyArray<{ value: TextScale; label: string }> = (
  ['small', 'default', 'large', 'larger'] as const
).map((value) => ({ value, get label() { return TEXT_SCALE_LABELS[value]; } }));

/**
 * What the Theme row says while a choice is being written to the device this
 * app shares with its older self.
 *
 * Fixed sentences about the person's own setting. The device's modes, messages
 * and storage are its business, and none of them are repeated here. Nothing
 * claims a save before the device has confirmed one, and a refused write says
 * what is in use instead so the control can simply be pressed again.
 */
const THEME_SYNC_FEEDBACK: Record<
  ThemeSyncState,
  { tone: 'info' | 'success' | 'caution' | 'danger'; message: string } | null
> = {
  idle: null,
  saving: { tone: 'info', get message() { return t("settings-page.saving.your.theme.on.this.device.f29331"); } },
  saved: { tone: 'success', get message() { return t("settings-page.theme.saved.on.this.device.731eca"); } },
  imported: { tone: 'success', get message() { return t("settings-page.theme.brought.over.from.your.earlier.pdf.0ee1f6"); } },
  failed: {
    tone: 'danger',
    get message() { return t("settings-page.your.theme.could.not.be.saved.on.7be204"); },
  },
  unsaved: {
    tone: 'caution',
    get message() { return t("settings-page.your.theme.is.in.use.now.but.6cae66"); },
  },
};

// Pages opened from here say "Settings" on their Back control, since that is where it goes.
const BACK_TO_SETTINGS = { from: '/settings' };

// The count reuses the home screen's sentence, which already reads "1 full job left" in every
// language. A sentence ending in "。" needs no space before the next one.
const freeJobsDetail = (remaining: number): string => {
  const count = t("dashboard.full.job.left.in.this.7.day.252761", { v0: remaining, count: remaining });
  return `${count}${/[。！？]$/u.test(count) ? '' : ' '}${t("settings-page.processing.stays.unlimited.later.results.643d0a")}`;
};

export const SettingsPage: React.FC = () => {
  const { preference } = useI18n();
  const [changingLanguage, setChangingLanguage] = useState(false);
  const { theme, setTheme, themeSync, textScale, setTextScale, resetAppearance } = useAppearance();
  const themeFeedback = THEME_SYNC_FEEDBACK[themeSync];
  const platform = useWorkspacePlatform();
  const monetization = useMonetization();
  const support = useSupport();
  const { state: recentState, refresh } = useRecentRecords();
  const storage = useStorageInformation();
  const metadata = useApplicationMetadata();

  const [settings, setSettings] = useState<WorkspaceSettings>(() => getWorkspaceSettings());
  const [confirm, setConfirm] = useState<'history' | 'reset' | null>(null);
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState('');

  const save = useCallback((patch: Partial<WorkspaceSettings>) => {
    setSettings(updateWorkspaceSettings(patch));
  }, []);

  const records = recentState.status === 'ready' ? recentState.value : [];
  const savings = useMemo(() => knownSpaceSaved(records), [records]);
  const retainedBytes = useMemo(
    () => records.reduce((total, record) => total + (record.document?.sizeBytes ?? 0), 0),
    [records],
  );

  return (
    <>
      <TabHeader title={t("settings-page.settings.74a883")} />

      <div className="mx-auto max-w-4xl px-4 pb-6 md:px-8">
        {support.state && <div className="mb-3"><SupporterBadge /></div>}
        {(notice || problem) && (
          <div role="status" aria-live="polite" className="mb-2">
            <StatusLine tone={problem ? 'danger' : 'success'}>{problem || notice}</StatusLine>
          </div>
        )}

        <Group title={t('settings.language')}>
          <Row stacked>
            <label className="sr-only" htmlFor="app-language">{t('settings.language')}</label>
            <select id="app-language" className="chef-field" value={preference}
              disabled={changingLanguage} onChange={(event) => {
                const next = event.target.value as LocalePreference;
                setChangingLanguage(true);
                void setLocalePreference(next).catch(() => setProblem(t('settings.languageUnavailable')))
                  .finally(() => setChangingLanguage(false));
              }}>
              <option value="system">{t('settings.systemLanguage')}</option>
              {locales.map(([value, name, , , dir]) => <option key={value} value={value} lang={value} dir={dir}>{name}</option>)}
            </select>
          </Row>
        </Group>

        {monetization.available && (
          <Group title={t("settings-page.access.ec5ba0")}>
            <Row
              label={monetization.access?.unlocked ? t("settings-page.pro.access.active.ff802b") : t("settings-page.free.full.jobs.fbcf6a")}
              detail={monetization.access?.unlocked
                ? monetization.access.monthlyActive
                  ? t("settings-page.pro.monthly.renews.automatically.until.cancelled.in.f0d32b")
                  : t("settings-page.pro.lifetime.is.a.one.time.purchase.ff132b")
                : freeJobsDetail(monetization.freeRemaining ?? 0)}
              stacked
            >
              <div className="flex flex-wrap gap-2">
                {(monetization.products.length > 0 ? monetization.products : []).map(product => (
                  <Button
                    key={product.productId}
                    tone={product.kind === 'lifetime' ? 'primary' : 'secondary'}
                    busy={monetization.loading}
                    disabled={Boolean(monetization.access?.unlocked)}
                    onClick={() => {
                      setNotice('');
                      setProblem('');
                      void monetization.purchase(product.productId)
                        .then(result => {
                          setNotice(result.status === 'pending'
                            ? t("settings-page.purchase.is.pending.apple.approval.63a4ca")
                            : result.status === 'cancelled'
                              ? t("settings-page.purchase.cancelled.no.charge.was.made.c6979a")
                              : t("settings-page.pro.access.is.active.194781"));
                        })
                        .catch(caught => setProblem(caught instanceof Error ? localizeError(caught) : t("settings-page.purchase.could.not.be.completed.7dc3ee")));
                    }}
                  >
                    {product.kind === 'lifetime'
                      ? t("settings-page.pro.lifetime.one.time.b6975d", { v0: product.displayPrice })
                      : t("settings-page.pro.monthly.month.e6188f", { v0: product.displayPrice })}
                  </Button>
                ))}
                {monetization.products.length === 0 && (
                  <Button tone="primary" onClick={monetization.showPaywall}>{t("settings-page.unlock.pro.3d173f")}</Button>
                )}
              </div>
            </Row>
            {monetization.freeResetDate && !monetization.access?.unlocked && (
              <Row label={t("settings-page.allowance.resets.e4b4bb")}>
                <span className="type-footnote tabular text-end text-[var(--text-secondary)]">
                  {new Date(monetization.freeResetDate).toLocaleDateString(getLocale())}
                </span>
              </Row>
            )}
            <Row stacked>
              <div className="flex flex-wrap gap-2">
                <Button tone="quiet" onClick={() => {
                  setNotice('');
                  setProblem('');
                  void monetization.restore()
                    .then(access => setNotice(access.unlocked ? t("settings-page.your.pro.access.has.been.restored.ff4ea5") : t("settings-page.no.previous.pro.purchase.was.found.d53b6c")))
                    .catch(caught => setProblem(caught instanceof Error ? localizeError(caught) : t("settings-page.restore.could.not.be.completed.ccc989")));
                }}>{t("settings-page.restore.purchases.c63999")}</Button>
                <Button tone="quiet" disabled={!monetization.access?.monthlyActive} onClick={() => void monetization.manageSubscriptions()}>{t("settings-page.manage.subscription.9041c6")}</Button>
                <Link to="/terms" state={BACK_TO_SETTINGS} className="chef-pressable chef-target inline-flex items-center rounded-[var(--radius-control)] px-3 text-sm font-semibold text-[var(--accent-text)] underline underline-offset-2">{t("settings-page.terms.ede548")}</Link>
                <Link to="/privacy" state={BACK_TO_SETTINGS} className="chef-pressable chef-target inline-flex items-center rounded-[var(--radius-control)] px-3 text-sm font-semibold text-[var(--accent-text)] underline underline-offset-2">{t("settings-page.privacy.54a57c")}</Link>
              </div>
            </Row>
          </Group>
        )}

        <Group title={t("settings-page.appearance.3907fa")}>
          <Row label={t("settings-page.theme.efb52e")} stacked>
            <SegmentedControl label={t("settings-page.theme.efb52e")} value={theme} options={THEME_OPTIONS} onChange={setTheme} columns={3} />
            {/* The answer belongs to the control that asked the question, so it
                sits in this row, in flow, at the width of the choice above it.
                A floating notice for a setting would land far from the setting
                and outlive the screen it belongs to. The control stays live
                throughout: a refused write is a reason to press again, not a
                reason to be locked out. */}
            {themeFeedback && (
              <div role="status" aria-live="polite" className="chef-enter">
                <StatusLine tone={themeFeedback.tone}>{themeFeedback.message}</StatusLine>
              </div>
            )}
          </Row>
          <Row label={t("settings-page.text.size.d68761")} stacked>
            {/* Four options hold one row only while each still fits a quarter
                of it. At Largest a 360px phone leaves about 57px of content per
                cell and "Compact" and "Default" are single unbreakable words
                wider than that, so a fixed four-up ran them into each other.

                Past Default the strip hands over to the rem-basis wrap. Four
                is an even number and reflows evenly: a 6.5rem basis fits two
                per row and never three, so the control becomes 2x2 with every
                cell filled and the reading order intact. A three-up would
                strand the fourth option alone in a half-empty row, which is
                arbitrary where 2x2 is not. Because the basis is in rem it keeps
                degrading in step with the text — at a system scale past this
                one it settles into a single column rather than colliding.

                Compact and Default keep the fixed four-up exactly as it was. */}
            <SegmentedControl
              label={t("settings-page.text.size.d68761")}
              value={textScale}
              options={TEXT_SCALE_OPTIONS}
              onChange={setTextScale}
              columns={textScale === 'small' || textScale === 'default' ? 4 : undefined}
            />
          </Row>
          <Row label={t("settings-page.interface.font.ad55b7")} stacked>
            <label htmlFor="interface-font" className="sr-only">{t("settings-page.interface.font.ad55b7")}</label>
            <select
              id="interface-font"
              className="chef-field"
              value={settings.interfaceFont}
              onChange={(event) => save({ interfaceFont: event.target.value as WorkspaceSettings['interfaceFont'] })}
            >
              <option value="inter">{t("settings-page.inter.30a4a5")}</option>
              <option value="system">{t("settings-page.system.6725e7")}</option>
              <option value="manrope">{t("settings-page.manrope.dfdf60")}</option>
              <option value="noto-sans">{t("settings-page.noto.sans.e42550")}</option>
              <option value="serif">{t("settings-page.serif.1b5e74")}</option>
              <option value="monospace">{t("settings-page.monospace.64c223")}</option>
            </select>
          </Row>
        </Group>

        {savings.known > 0 && (
          <Group title={t("settings-page.space.saved.12824d")}>
            <Row label={formatBytes(savings.bytes)} />
          </Group>
        )}

        <Group title={t("settings-page.documents.and.history.42a2ea")}>
          {/* The two labels name different things outright, so neither needs a
              line under it explaining that it is not the other one. */}
          <Switch
            label={t("settings-page.keep.results.in.recent.bf522d")}
            checked={settings.keepLocalHistory}
            onChange={(keepLocalHistory) => save({ keepLocalHistory })}
          />
          {platform.capabilities.automaticExternalExport !== false && (
            <Switch
              label={t("settings-page.download.automatically.when.a.job.finishes.dcf3b4")}
              checked={settings.autoDownload}
              onChange={(autoDownload) => save({ autoDownload })}
            />
          )}
          <Row label={t("settings-page.storage.used.19fc4d")}>
            <span className="type-footnote tabular text-end text-[var(--text-secondary)]">
              {storage.status === 'loading'
                ? t("settings-page.reading.874bfa")
                : storage.status === 'error'
                  ? storage.message
                  : storage.value
                    ? t("settings-page.used.c41135", { v0: formatBytes(storage.value.retainedBytes), v1: storage.value.availableBytes !== null
                          ? t('settings.availableBytes', { size: formatBytes(storage.value.availableBytes) })
                          : '' })
                    : t("settings-page.about.used.f25d44", { v0: formatBytes(retainedBytes) })}
            </span>
          </Row>
          <Row
            label={t("settings-page.clear.recent.36f2b8")}
            detail={t("settings-page..24a420", { count: records.length })}
            stacked
          >
            <Button tone="destructive" disabled={records.length === 0} onClick={() => setConfirm('history')}>{t("settings-page.clear.83b12c")}</Button>
          </Row>
        </Group>

        <Group title={t("settings-page.large.documents.767508")}>
          <Switch
            label={t("settings-page.warn.before.a.heavy.job.672c20")}
            checked={settings.confirmLargeJobs}
            onChange={(confirmLargeJobs) => save({ confirmLargeJobs })}
          />
          <Row label={t("settings-page.warn.above.0f9d77")} stacked={false}>
            <span className="flex items-center gap-2">
              <label htmlFor="large-threshold" className="sr-only">{t("settings-page.large.document.warning.threshold.in.megabytes.79cc16")}</label>
              <input
                id="large-threshold"
                type="number"
                inputMode="numeric"
                min={20}
                max={500}
                step={10}
                disabled={!settings.confirmLargeJobs}
                value={settings.largeFileWarningMb}
                onChange={(event) =>
                  save({ largeFileWarningMb: Math.max(20, Math.min(500, Number(event.target.value) || 80)) })
                }
                className="chef-field tabular w-24 disabled:opacity-55"
              />
              <span className="text-[var(--text-secondary)]">{t("settings-page.mb.1d09f6")}</span>
            </span>
          </Row>
        </Group>

        <Group title={t("settings-page.more.d47d7c")}>
          <Row stacked>
            <div className="flex flex-wrap gap-2">
              <Link
                to="/help" state={BACK_TO_SETTINGS}
                className="chef-pressable chef-target inline-flex items-center rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 font-semibold text-[var(--text-primary)]"
              >{t("settings-page.help.b79cac")}</Link>
              <Link
                to="/privacy" state={BACK_TO_SETTINGS}
                className="chef-pressable chef-target inline-flex items-center rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 font-semibold text-[var(--text-primary)]"
              >{t("settings-page.privacy.54a57c")}</Link>
              <Link
                to="/terms" state={BACK_TO_SETTINGS}
                className="chef-pressable chef-target inline-flex items-center rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 font-semibold text-[var(--text-primary)]"
              >{t("settings-page.terms.ede548")}</Link>
            </div>
          </Row>
        </Group>

        {support.state && (support.state.supporter !== 'none' || support.state.monthlyPrice || support.state.lifetimePrice) && (
          <Group title={t("support.support.pdf.chef.3b92ab")}>
            {support.state.supporter === 'none' ? (
              <Row detail={t("support.pdf.chef.is.free.for.everyone.with.dba2fa")} stacked>
                <SupportChoices />
              </Row>
            ) : (
              <Row label={t("support.thank.you.for.supporting.pdf.chef.c645eb")} stacked={support.state.supporter === 'monthly'}>
                {support.state.supporter === 'monthly' && (
                  <Button
                    icon={<ExternalLink aria-hidden size={14} />}
                    onClick={() => {
                      setProblem('');
                      void support.manage().catch(() => setProblem(t("support.google.play.could.not.be.opened.14c8dd")));
                    }}
                  >{t("support.manage.in.google.play.fc229c")}</Button>
                )}
              </Row>
            )}
          </Group>
        )}

        <Group title={t("settings-page.about.4efca0")}>
          <Row label="PDF Chef">
            <span className="type-footnote tabular text-end text-[var(--text-secondary)]">
              {metadata.status === 'loading'
                ? t("settings-page.reading.version.8693f6")
                : metadata.status === 'error'
                  ? metadata.message
                  : metadata.value
                    ? t("settings-page.version.bd0f7d", { v0: metadata.value.version, v1: metadata.value.build ? ` (${metadata.value.build})` : '' })
                    : t("settings-page.version.unavailable.c0a7f6")}
            </span>
          </Row>
          <Row stacked>
            <Link
              to="/licenses" state={BACK_TO_SETTINGS}
              className="chef-pressable chef-target flex w-full items-center justify-between gap-3 rounded-[var(--radius-control)] font-semibold text-[var(--text-primary)]"
            >
              {t("settings-page.open.source.licenses.c9f6d0")}
              <ChevronRight aria-hidden size={18} className="shrink-0 text-[var(--text-secondary)] rtl:rotate-180" />
            </Link>
          </Row>
          <Row label={t("settings-page.source.code.bf046c")} stacked>
            <a
              href="https://github.com/DhananjayBhosale/PDFChef"
              target="_blank"
              rel="noreferrer"
              className="chef-pressable chef-target inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 font-semibold text-[var(--text-primary)]"
            >{t("settings-page.github.f911e4")}<ExternalLink aria-hidden size={14} />
            </a>
          </Row>
        </Group>

        <Group title={t("settings-page.reset.daee76")}>
          <Row label={t("settings-page.reset.settings.d33a83")}>
            <Button onClick={() => setConfirm('reset')}>{t("settings-page.reset.daee76")}</Button>
          </Row>
        </Group>

        {!platform.capabilities.durableDocuments && (
          <div className="mt-6">
            <StatusLine tone="caution" icon={<AlertTriangle size={15} />}>{t("settings-page.clearing.this.browser.rsquo.s.data.will.2c0a4f")}</StatusLine>
          </div>
        )}
      </div>

      <ConfirmSheet
        open={confirm === 'history'}
        title={t("settings-page.clear.recent.7b6aff")}
        description={t("settings-page.copies.saved.elsewhere.are.not.affected.1ed2fd")}
        confirmLabel={t("settings-page.clear.recent.36f2b8")}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          // Clearing goes through the injected records port, and the confirmation
          // only appears once it has actually resolved. A failure says so instead
          // of reporting a deletion that did not happen.
          setNotice('');
          setProblem('');
          try {
            await platform.records.clearRecords();
            announceRecordsChanged();
            await refresh();
            setNotice(t("settings-page.recent.cleared.598fd2"));
          } catch (caught) {
            setProblem(
              caught instanceof Error && caught.message
                ? caught.message
                : t("settings-page.recent.could.not.be.cleared.nothing.was.30ad92"),
            );
          } finally {
            setConfirm(null);
          }
        }}
      />

      {/* Reset changes settings the person deliberately chose, so it asks first
          like every other control here that cannot be undone. The description
          carries only what the title cannot: Recent is left alone. */}
      <ConfirmSheet
        open={confirm === 'reset'}
        title={t("settings-page.reset.settings.9d6440")}
        description={t("settings-page.your.results.in.recent.are.not.affected.c42e6a")}
        confirmLabel={t("settings-page.reset.settings.d33a83")}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setProblem('');
          resetAppearance();
          setSettings(
            updateWorkspaceSettings({
              autoDownload: true,
              keepLocalHistory: true,
              confirmLargeJobs: true,
              largeFileWarningMb: 80,
              interfaceFont: 'inter',
            }),
          );
          setNotice(t("settings-page.settings.reset.28f3ac"));
          setConfirm(null);
        }}
      />
    </>
  );
};
