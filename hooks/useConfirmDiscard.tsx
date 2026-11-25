import React, { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../services/i18n/core.ts';
import { ConfirmSheet } from '../components/UI/Primitives';

/**
 * Asks before throwing away unsaved work, in the app's own sheet. On iOS, `window.confirm`
 * is drawn by Capacitor with fixed English "Cancel" and "Ok" buttons; this one says "Discard".
 */
export const useDiscardPrompt = (options: {
  readonly title?: string;
  /**
   * Offers Save as the main way out. Resolves true when everything was saved: only then does the
   * prompt go on to leave. Otherwise the sheet closes and the work and the save's message stay.
   */
  readonly save?: () => Promise<boolean>;
} = {}): { ask: (discard: () => void, keep?: () => void) => void; sheet: React.ReactNode } => {
  const [pending, setPending] = useState<{ discard: () => void; keep?: () => void } | null>(null);
  const ask = useCallback((discard: () => void, keep?: () => void) => setPending({ discard, keep }), []);
  const save = options.save;
  const sheet = (
    <ConfirmSheet
      open={pending !== null}
      title={options.title ?? t('edit-pdf.discard.your.unsaved.edits.1575c6')}
      description=""
      confirmLabel={t('edit-pdf.discard.eb1a70')}
      onConfirm={() => {
        setPending(null);
        pending?.discard();
      }}
      onCancel={() => {
        setPending(null);
        pending?.keep?.();
      }}
      keepLabel={save ? t('edit-pdf.save.1509f5') : undefined}
      onKeep={save ? async () => {
        const saved = await save();
        setPending(null);
        if (saved) pending?.discard();
        else pending?.keep?.();
      } : undefined}
    />
  );
  return { ask, sheet };
};

type LeaveGuard = { active: boolean; ask?: (leave: () => void, stay: () => void) => void };
const guards: LeaveGuard[] = [];

/**
 * Marks that the tool will ask before leaving its own unsaved work ("Discard your unsaved edits?")
 * while `active`. The tool screen holds the app's one navigation blocker (React Router honours only
 * the last one registered): it asks through `ask` when a guard is active, and the tool screen's own
 * leave question stands aside, so nobody is asked twice.
 */
export const useLeaveGuarded = (active: boolean, ask?: LeaveGuard['ask']) => {
  const guard = useRef<LeaveGuard>({ active, ask });
  useEffect(() => {
    const own = guard.current;
    guards.push(own);
    return () => { guards.splice(guards.indexOf(own), 1); own.active = false; };
  }, []);
  useEffect(() => {
    guard.current.active = active;
    guard.current.ask = ask;
  }, [active, ask]);
};

/** True while a tool's own guard will ask before leaving. */
export const leaveGuarded = () => guards.some((guard) => guard.active);

/** The guard that asks for the tool, the latest active one. */
export const activeLeaveGuard = () => [...guards].reverse().find((guard) => guard.active && guard.ask) ?? null;

/** Ask before Back or a link leaves work that has not been saved, as Edit PDF does. Render the returned sheet. */
export const useConfirmDiscard = (unsaved: boolean): React.ReactNode => {
  const { ask, sheet } = useDiscardPrompt();
  useLeaveGuarded(unsaved, ask);
  return sheet;
};
