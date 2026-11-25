import React, { useCallback, useState } from 'react';
import { t } from '../services/i18n/core.ts';
import { shouldWarnForBytes } from '../services/workspace';
import { ConfirmSheet } from '../components/UI/Primitives';

/**
 * "Warn before a heavy job" (Settings), asked in the app's own sheet (fix round 2, item 7). On iOS a
 * browser `confirm` is drawn in English with "Cancel" and "OK"; this one says Continue, and Cancel
 * keeps the file where it is. Resolves true when the job may go ahead: at once when the work is
 * under the threshold or the setting is off. Render the returned sheet.
 */
export const useHeavyJobCheck = (): { confirm: (bytes: number, title: string) => Promise<boolean>; sheet: React.ReactNode } => {
  const [pending, setPending] = useState<{ title: string; resolve: (go: boolean) => void } | null>(null);
  const confirm = useCallback((bytes: number, title: string) => new Promise<boolean>((resolve) => {
    if (!shouldWarnForBytes(bytes)) { resolve(true); return; }
    setPending({ title, resolve });
  }), []);
  const settle = (go: boolean) => {
    pending?.resolve(go);
    setPending(null);
  };
  const sheet = (
    <ConfirmSheet
      open={pending !== null}
      title={pending?.title ?? ''}
      description=""
      confirmLabel={t('heavy-job.continue')}
      confirmTone="primary"
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
  return { confirm, sheet };
};
