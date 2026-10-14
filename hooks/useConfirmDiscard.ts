import { useEffect } from 'react';
import { useBlocker } from 'react-router-dom';
import { t } from '../services/i18n/core.ts';

/** Ask before Back or a link leaves work that has not been saved, as Edit PDF does. */
export const useConfirmDiscard = (unsaved: boolean): void => {
  const blocker = useBlocker(unsaved);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm(t('edit-pdf.discard.your.unsaved.edits.1575c6'))) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
};
