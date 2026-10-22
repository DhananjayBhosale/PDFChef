import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useState } from 'react';
import { Crown, Heart } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useSupport } from '../../hooks/useSupport';
import { useApplicationMetadata } from '../../hooks/useWorkspaceRuntime';
import type { SupportPlan, SupportResult } from '../../services/platform/android/androidSupport';
import { markSupportPrompted, readFinishedJobs, readPromptedBuild, shouldOfferSupport } from '../../services/supportPrompt';
import { getWorkspaceSettings } from '../../services/workspace';
import { Badge, Button, Sheet, StatusLine } from './Primitives';

const resultMessage = (result: SupportResult): { tone: 'info' | 'success' | 'caution'; text: string } => {
  switch (result) {
    case 'supported': return { tone: 'success', text: t("support.thank.you.for.supporting.pdf.chef.c645eb") };
    case 'pending': return { tone: 'info', text: t("support.your.payment.is.pending.google.play.will.a6c050") };
    case 'cancelled': return { tone: 'info', text: t("support.no.payment.was.made.83f840") };
    default: return { tone: 'caution', text: t("support.google.play.could.not.take.the.payment.24ebe2") };
  }
};

/** The Settings header badge. It names the person's support, never what they can use: every tool is free. */
export const SupporterBadge: React.FC = () => {
  useI18n();
  const { state } = useSupport();
  if (!state) return null;
  if (state.supporter === 'lifetime') {
    return <Badge tone="accent"><Crown aria-hidden size={13} />{t("support.lifetime.supporter.9645ff")}</Badge>;
  }
  if (state.supporter === 'subscriber') {
    return <Badge tone="accent"><Heart aria-hidden size={13} />{t("support.proud.supporter.1ba564")}</Badge>;
  }
  return <Badge>{t("support.free.f411a1")}</Badge>;
};

/** The Monthly, Yearly and Lifetime buttons with Google Play's own prices. Nothing here unlocks anything. */
export const SupportChoices: React.FC<{ onSupported?: () => void }> = ({ onSupported }) => {
  useI18n();
  const { state, busy, support } = useSupport();
  const [result, setResult] = useState<SupportResult | null>(null);
  if (!state) return null;

  const choose = async (plan: SupportPlan) => {
    setResult(null);
    const next = await support(plan);
    if (next === 'supported' && onSupported) onSupported();
    else setResult(next);
  };
  const message = state.pending ? resultMessage('pending') : result ? resultMessage(result) : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {state.monthlyPrice && (
          <Button busy={busy === 'monthly'} disabled={busy !== null || state.pending} onClick={() => void choose('monthly')}>
            {t("support.monthly.755a07", { v0: state.monthlyPrice })}
          </Button>
        )}
        {state.yearlyPrice && (
          <Button busy={busy === 'yearly'} disabled={busy !== null || state.pending} onClick={() => void choose('yearly')}>
            {t("support.yearly.67e003", { v0: state.yearlyPrice })}
          </Button>
        )}
        {state.lifetimePrice && (
          <Button busy={busy === 'lifetime'} disabled={busy !== null || state.pending} onClick={() => void choose('lifetime')}>
            {t("support.lifetime.3a44a8", { v0: state.lifetimePrice })}
          </Button>
        )}
      </div>
      {message && <StatusLine tone={message.tone}>{message.text}</StatusLine>}
      <p className="type-footnote text-[var(--text-tertiary)]">{t("support.monthly.and.yearly.support.renew.until.you.819b90")}</p>
    </div>
  );
};

/**
 * One gentle ask per app update, on Tools home, after the person has finished enough jobs.
 * "Continue free" is the main button, and closing it changes nothing.
 */
export const SupportPrompt: React.FC = () => {
  useI18n();
  const { state } = useSupport();
  const metadata = useApplicationMetadata();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (shown || pathname !== '/' || metadata.status !== 'ready' || !metadata.value) return;
    // Never stacks on a result sheet or a first-run sheet.
    if (!getWorkspaceSettings().onboardingComplete || document.querySelector('[role="dialog"]')) return;
    const build = metadata.value.build ?? metadata.value.version;
    if (!shouldOfferSupport({ state, finishedJobs: readFinishedJobs(), build, promptedBuild: readPromptedBuild() })) return;
    markSupportPrompted(build);
    setShown(true);
    setOpen(true);
  }, [metadata, pathname, shown, state]);

  return (
    <Sheet
      open={open}
      onClose={() => setOpen(false)}
      title={t("support.enjoying.pdf.chef.577d88")}
      description={t("support.pdf.chef.is.free.for.everyone.and.4332ee")}
      footer={<Button tone="primary" block onClick={() => setOpen(false)}>{t("support.continue.free.feb5a8")}</Button>}
    >
      <SupportChoices onSupported={() => setOpen(false)} />
      <p className="type-footnote mt-2 text-[var(--text-tertiary)]">{t("support.shown.once.per.app.update.0577b2")}</p>
    </Sheet>
  );
};
