import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useState } from 'react';
import { CloudOff, HardDrive, ShieldCheck, WifiOff } from 'lucide-react';
import { getWorkspaceSettings, updateWorkspaceSettings } from '../../services/workspace';
import { Button, Sheet } from './Primitives';
import { useHaptics } from '../../hooks/useWorkspaceRuntime';
import { useMonetization } from '../../hooks/useMonetization';

/** First run. Four short facts about local processing and retention. */
const POINTS = [
  {
    icon: ShieldCheck,
    get title() { return t("onboarding.your.documents.stay.on.this.device.2dc8b1"); },
  },
  {
    icon: CloudOff,
    get title() { return t("onboarding.nothing.is.uploaded.no.account.is.needed.58a6e1"); },
  },
  {
    icon: WifiOff,
    get title() { return t("onboarding.tools.work.offline.after.the.app.loads.b100fa"); },
  },
  {
    icon: HardDrive,
    get title() { return t("onboarding.you.choose.when.eligible.results.are.kept.e76303"); },
  },
] as const;

export const Onboarding: React.FC = () => {
  useI18n();
  const [open, setOpen] = useState(() => !getWorkspaceSettings().onboardingComplete);
  const haptic = useHaptics();
  const { available: monetizationAvailable } = useMonetization();

  const finish = () => {
    updateWorkspaceSettings({ onboardingComplete: true });
    haptic('commit');
    setOpen(false);
  };

  return (
    <Sheet
      open={open}
      onClose={finish}
      title={t("onboarding.before.you.start.74e492")}
      footer={
        <Button tone="primary" block onClick={finish}>{t("onboarding.start.using.pdf.chef.b2a8f1")}</Button>
      }
    >
      <ul className="space-y-2">
        {[...POINTS, ...(monetizationAvailable ? [{ icon: ShieldCheck, title: t("onboarding.on.ios.each.7.day.allowance.starts.c4855a") }] : [])].map(({ icon: Icon, title }) => (
          <li key={title} className="flex items-center gap-3">
            <span
              aria-hidden
              className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)] bg-[var(--accent-quiet)] text-[var(--accent-on-quiet)]"
            >
              <Icon size={18} strokeWidth={1.9} />
            </span>
            <span className="min-w-0 font-medium text-[var(--text-primary)]">{title}</span>
          </li>
        ))}
      </ul>
    </Sheet>
  );
};
