import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { wasRendererRestarted } from '../../services/rendererRecovery';

/**
 * Says so once when the Android or iOS shell has reopened this screen after the page's
 * renderer died. The marker is taken out of the address at once, so a later
 * refresh of the same screen does not repeat the message.
 */
export const RendererRecoveryNotice = () => {
  useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!wasRendererRestarted(location.hash)) return;
    setShown(true);
    navigate({ pathname: location.pathname, search: location.search, hash: '' }, { replace: true, state: location.state });
  }, [location.hash, location.pathname, location.search, location.state, navigate]);

  if (!shown) return null;
  return <div role="alert" className="fixed left-4 right-4 top-[calc(1rem+env(safe-area-inset-top))] z-[200] rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-raised)] p-4 shadow-lg">
    <p>{t("renderer-recovery-notice.pdf.chef.reopened.this.screen.after.4c665a")}</p>
    <button type="button" onClick={() => setShown(false)} className="mt-2 min-h-11 underline">{t("android-incoming-pdf-handler.dismiss.48845b")}</button>
  </div>;
};
