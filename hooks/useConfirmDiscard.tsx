import React, { useCallback, useEffect, useState } from 'react';
import { useBlocker } from 'react-router-dom';
import { t } from '../services/i18n/core.ts';
import { ConfirmSheet } from '../components/UI/Primitives';

/**
 * Asks before throwing away unsaved work, in the app's own sheet. On iOS, `window.confirm`
 * is drawn by Capacitor with fixed English "Cancel" and "Ok" buttons; this one says "Discard".
 */
export const useDiscardPrompt = (options: { readonly title?: string } = {}): { ask: (discard: () => void, keep?: () => void) => void; sheet: React.ReactNode } => {
  const [pending, setPending] = useState<{ discard: () => void; keep?: () => void } | null>(null);
  const ask = useCallback((discard: () => void, keep?: () => void) => setPending({ discard, keep }), []);
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
    />
  );
  return { ask, sheet };
};

/** Ask before Back or a link leaves work that has not been saved, as Edit PDF does. Render the returned sheet. */
export const useConfirmDiscard = (unsaved: boolean): React.ReactNode => {
  const blocker = useBlocker(unsaved);
  const { ask, sheet } = useDiscardPrompt();
  useEffect(() => {
    if (blocker.state === 'blocked') ask(() => blocker.proceed(), () => blocker.reset());
  }, [blocker, ask]);
  return sheet;
};
