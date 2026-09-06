import React, { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { getWorkspaceSettings, updateWorkspaceSettings, type WorkspaceSettings } from '../../services/workspace';
import { TabHeader } from '../Layout/AppShell';
import { Button, ConfirmSheet, SegmentedControl, StatusLine, Switch, cx } from '../UI/Primitives';
import { formatBytes } from '../UI/format';
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
}> = ({ title, children }) => (
  <section className="mt-5 first:mt-1">
    <h2 className="type-caption px-4 pb-1 uppercase tracking-[0.08em] text-[var(--text-tertiary)]">{title}</h2>
    <div className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--surface-raised)] px-4">
      {children}
    </div>
  </section>
);

const Row: React.FC<{ label?: string; detail?: string; children?: React.ReactNode; stacked?: boolean }> = ({
  label,
  detail,
  children,
  stacked = false,
}) => (
  <div className={cx('py-2.5', stacked ? 'space-y-2' : 'flex flex-wrap items-center justify-between gap-3')}>
    <div className={cx('min-w-0', !label && !detail && 'hidden')}>
      {label && <p className="font-semibold text-[var(--text-primary)]">{label}</p>}
      {detail && <p className="type-footnote mt-0.5 max-w-measure text-[var(--text-secondary)]">{detail}</p>}
    </div>
    {children}
  </div>
);

/* --------------------------------------------------------------- Page --- */

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const TEXT_SCALE_OPTIONS: ReadonlyArray<{ value: TextScale; label: string }> = (
  ['small', 'default', 'large', 'larger'] as const
).map((value) => ({ value, label: TEXT_SCALE_LABELS[value] }));

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
  saving: { tone: 'info', message: 'Saving your theme on this device…' },
  saved: { tone: 'success', message: 'Theme saved on this device.' },
  imported: { tone: 'success', message: 'Theme brought over from your earlier PDF Chef settings.' },
  failed: {
    tone: 'danger',
    message: 'Your theme could not be saved on this device. Your last saved theme is still in use.',
  },
  unsaved: {
    tone: 'caution',
    message: 'Your theme is in use now, but this device did not store it. It may go back after a restart.',
  },
};

export const SettingsPage: React.FC = () => {
  const { theme, setTheme, themeSync, textScale, setTextScale, resetAppearance } = useAppearance();
  const themeFeedback = THEME_SYNC_FEEDBACK[themeSync];
  const platform = useWorkspacePlatform();
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
      <TabHeader title="Settings" />

      <div className="mx-auto max-w-4xl px-4 pb-6 md:px-8">
        {(notice || problem) && (
          <div role="status" aria-live="polite" className="mb-2">
            <StatusLine tone={problem ? 'danger' : 'success'}>{problem || notice}</StatusLine>
          </div>
        )}

        <Group title="Appearance">
          <Row label="Theme" stacked>
            <SegmentedControl label="Theme" value={theme} options={THEME_OPTIONS} onChange={setTheme} columns={3} />
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
          <Row label="Text size" stacked>
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
              label="Text size"
              value={textScale}
              options={TEXT_SCALE_OPTIONS}
              onChange={setTextScale}
              columns={textScale === 'small' || textScale === 'default' ? 4 : undefined}
            />
          </Row>
          <Row label="Interface font" stacked>
            <label htmlFor="interface-font" className="sr-only">
              Interface font
            </label>
            <select
              id="interface-font"
              className="chef-field"
              value={settings.interfaceFont}
              onChange={(event) => save({ interfaceFont: event.target.value as WorkspaceSettings['interfaceFont'] })}
            >
              <option value="inter">Inter</option>
              <option value="system">System</option>
              <option value="manrope">Manrope</option>
              <option value="noto-sans">Noto Sans</option>
              <option value="serif">Serif</option>
              <option value="monospace">Monospace</option>
            </select>
          </Row>
        </Group>

        {savings.known > 0 && (
          <Group title="Space saved">
            <Row label={formatBytes(savings.bytes)} />
          </Group>
        )}

        <Group title="Documents and history">
          {/* The two labels name different things outright, so neither needs a
              line under it explaining that it is not the other one. */}
          <Switch
            label="Keep results in Recent"
            checked={settings.keepLocalHistory}
            onChange={(keepLocalHistory) => save({ keepLocalHistory })}
          />
          <Switch
            label="Download automatically when a job finishes"
            checked={settings.autoDownload}
            onChange={(autoDownload) => save({ autoDownload })}
          />
          <Row label="Storage used">
            <span className="type-footnote tabular text-right text-[var(--text-secondary)]">
              {storage.status === 'loading'
                ? 'Reading…'
                : storage.status === 'error'
                  ? storage.message
                  : storage.value
                    ? `${formatBytes(storage.value.retainedBytes)} used${
                        storage.value.availableBytes !== null
                          ? ` · ${formatBytes(storage.value.availableBytes)} free`
                          : ''
                      }`
                    : `About ${formatBytes(retainedBytes)} used`}
            </span>
          </Row>
          <Row
            label="Clear Recent"
            detail={`${records.length} ${records.length === 1 ? 'result' : 'results'}`}
            stacked
          >
            <Button tone="destructive" disabled={records.length === 0} onClick={() => setConfirm('history')}>
              Clear
            </Button>
          </Row>
        </Group>

        <Group title="Large documents">
          <Switch
            label="Warn before a heavy job"
            checked={settings.confirmLargeJobs}
            onChange={(confirmLargeJobs) => save({ confirmLargeJobs })}
          />
          <Row label="Warn above" stacked={false}>
            <span className="flex items-center gap-2">
              <label htmlFor="large-threshold" className="sr-only">
                Large document warning threshold in megabytes
              </label>
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
              <span className="text-[var(--text-secondary)]">MB</span>
            </span>
          </Row>
        </Group>

        <Group title="More">
          <Row stacked>
            <div className="flex flex-wrap gap-2">
              <Link
                to="/help"
                className="chef-pressable chef-target inline-flex items-center rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 font-semibold text-[var(--text-primary)]"
              >
                Help
              </Link>
              <Link
                to="/privacy"
                className="chef-pressable chef-target inline-flex items-center rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 font-semibold text-[var(--text-primary)]"
              >
                Privacy
              </Link>
              <Link
                to="/terms"
                className="chef-pressable chef-target inline-flex items-center rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 font-semibold text-[var(--text-primary)]"
              >
                Terms
              </Link>
            </div>
          </Row>
        </Group>

        <Group title="About">
          <Row label="PDF Chef">
            <span className="type-footnote tabular text-right text-[var(--text-secondary)]">
              {metadata.status === 'loading'
                ? 'Reading version…'
                : metadata.status === 'error'
                  ? metadata.message
                  : metadata.value
                    ? `Version ${metadata.value.version}${metadata.value.build ? ` (${metadata.value.build})` : ''}`
                    : 'Version unavailable'}
            </span>
          </Row>
          <Row
            label="Open-source licenses"
            detail="pptx-renderer (Apache-2.0), JSZip (MIT), Apache ECharts (Apache-2.0), html2canvas (MIT)."
          />
          <Row label="Source code" stacked>
            <a
              href="https://github.com/DhananjayBhosale/PDFChef"
              target="_blank"
              rel="noreferrer"
              className="chef-pressable chef-target inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 font-semibold text-[var(--text-primary)]"
            >
              GitHub
              <ExternalLink aria-hidden size={14} />
            </a>
          </Row>
        </Group>

        <Group title="Reset">
          <Row label="Reset settings">
            <Button onClick={() => setConfirm('reset')}>Reset</Button>
          </Row>
        </Group>

        {!platform.capabilities.durableDocuments && (
          <div className="mt-6">
            <StatusLine tone="caution" icon={<AlertTriangle size={15} />}>
              Clearing this browser&rsquo;s data will delete results stored here.
            </StatusLine>
          </div>
        )}
      </div>

      <ConfirmSheet
        open={confirm === 'history'}
        title="Clear Recent?"
        description="Copies saved elsewhere are not affected."
        confirmLabel="Clear Recent"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          // Clearing goes through the injected records port, and the confirmation
          // only appears once it has actually resolved. A failure says so instead
          // of reporting a deletion that did not happen.
          setNotice('');
          setProblem('');
          try {
            await platform.records.clearRecords();
            await refresh();
            setNotice('Recent cleared.');
          } catch (caught) {
            setProblem(
              caught instanceof Error && caught.message
                ? caught.message
                : 'Recent could not be cleared. Nothing was removed.',
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
        title="Reset settings?"
        description="Your results in Recent are not affected."
        confirmLabel="Reset settings"
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
          setNotice('Settings reset.');
          setConfirm(null);
        }}
      />
    </>
  );
};
