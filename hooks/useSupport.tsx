import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  AndroidSupportClient,
  isAndroidSupportAvailable,
  type AndroidSupportState,
  type SupportPlan,
  type SupportResult,
} from '../services/platform/android/androidSupport';
import { countFinishedJob } from '../services/supportPrompt';
import { OUTPUT_EVENT } from '../services/workspace';

export interface SupportContextValue {
  /** Null until Google Play answers, and always null off Android. */
  state: AndroidSupportState | null;
  busy: SupportPlan | null;
  support(plan: SupportPlan): Promise<SupportResult>;
  manage(): Promise<void>;
}

const SupportContext = createContext<SupportContextValue>({
  state: null,
  busy: null,
  support: async () => 'unavailable',
  manage: async () => undefined,
});

/** Optional Google Play support. It unlocks nothing; every tool stays free for everyone. */
export const SupportProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const client = useMemo(() => (isAndroidSupportAvailable() ? new AndroidSupportClient() : null), []);
  const [state, setState] = useState<AndroidSupportState | null>(null);
  const [busy, setBusy] = useState<SupportPlan | null>(null);

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      setState(await client.getSupport());
    } catch {
      setState(null);
    }
  }, [client]);

  useEffect(() => {
    if (!client) return undefined;
    void refresh();
    // A subscription cancelled in Google Play shows here when the person comes back.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(OUTPUT_EVENT, countFinishedJob);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(OUTPUT_EVENT, countFinishedJob);
    };
  }, [client, refresh]);

  const support = useCallback(async (plan: SupportPlan): Promise<SupportResult> => {
    if (!client) return 'unavailable';
    setBusy(plan);
    try {
      return await client.support(plan);
    } catch {
      return 'unavailable';
    } finally {
      setBusy(null);
      await refresh();
    }
  }, [client, refresh]);

  const manage = useCallback(async () => {
    if (client) await client.manageSupport();
  }, [client]);

  const value = useMemo(() => ({ state, busy, support, manage }), [state, busy, support, manage]);
  return <SupportContext.Provider value={value}>{children}</SupportContext.Provider>;
};

export const useSupport = () => useContext(SupportContext);
