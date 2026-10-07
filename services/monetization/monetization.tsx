import { LocalizedError } from '../i18n/errors.ts';
import { t } from '../i18n/core.ts';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  PDF_CHEF_LIFETIME_PRODUCT_ID,
  PDF_CHEF_MONTHLY_PRODUCT_ID,
  PdfChefPurchases,
  isPdfChefPurchasesAvailable,
  type PdfChefPurchaseAccess,
  type PdfChefPurchaseProduct,
  type PdfChefPurchaseResult,
  type PdfChefPurchasesNativePlugin,
} from '../platform/capacitor/pdfChefPurchases.ts';
import { installOutputAccessHandler, type OutputAccessDisposition } from '../pdfShared.ts';
import { PendingExport, authorizeExport } from './exportAccess.ts';

export {
  PDF_CHEF_LIFETIME_PRODUCT_ID,
  PDF_CHEF_MONTHLY_PRODUCT_ID,
  type PdfChefPurchaseAccess as MonetizationAccess,
  type PdfChefPurchaseProduct as MonetizationProduct,
};

export interface MonetizationState {
  available: boolean;
  loading: boolean;
  access: PdfChefPurchaseAccess | null;
  products: readonly PdfChefPurchaseProduct[];
  error: Error | null;
}

export interface ExportAccessResult<T> {
  status: 'completed' | 'blocked';
  value?: T;
}

export type JobAccessGrant = 'pro' | 'full' | 'preview-only';

export interface MonetizationContextValue extends MonetizationState {
  /** Browser and Android remain unrestricted. On native iOS this means an active entitlement. */
  canExport: boolean;
  freeRemaining: number | null;
  freeResetDate: string | null;
  paywallOpen: boolean;
  /** Closes the paywall and abandons the export waiting behind it. */
  dismissPaywall(): void;
  showPaywall(): void;
  requestUnlock(): Promise<boolean>;
  /** Complete one idempotent processing job without presenting purchase UI. */
  completeJob(operationId: string): Promise<JobAccessGrant>;
  /** Pass the result's operation ID so its export is metered against fresh native state. */
  runWithExportAccess<T>(operation: () => Promise<T> | T, options?: { operationId?: string }): Promise<ExportAccessResult<T>>;
  /** Abandons a waiting export, only the one for this result when an ID is given. */
  cancelPendingExport(operationId?: string): void;
  purchase(productId: string): Promise<PdfChefPurchaseResult>;
  restore(): Promise<PdfChefPurchaseAccess>;
  manageSubscriptions(): Promise<void>;
}

const MonetizationContext = createContext<MonetizationContextValue | null>(null);

const asError = (error: unknown): Error => error instanceof Error ? error : new LocalizedError("monetization.purchase.information.is.unavailable.02515c");

export interface MonetizationProviderProps {
  children: React.ReactNode;
  /** Test-only injection; production discovery always uses the Capacitor header. */
  bridge?: PdfChefPurchasesNativePlugin | null;
  available?: boolean;
}

export const MonetizationProvider: React.FC<MonetizationProviderProps> = ({ children, bridge, available }) => {
  const nativeAvailable = available ?? (bridge ? true : isPdfChefPurchasesAvailable());
  const native = useMemo(() => nativeAvailable ? (bridge ?? PdfChefPurchases) : null, [bridge, nativeAvailable]);
  const [state, setState] = useState<MonetizationState>({
    available: nativeAvailable,
    loading: nativeAvailable,
    access: null,
    products: [],
    error: null,
  });
  const [paywallOpen, setPaywallOpen] = useState(false);
  const pendingExport = useRef(new PendingExport());
  const stateRef = useRef(state);
  stateRef.current = state;

  const applyAccess = useCallback((access: PdfChefPurchaseAccess) => {
    setState(current => ({ ...current, loading: false, access, error: null }));
  }, []);

  const resumePendingExport = useCallback(async (access: PdfChefPurchaseAccess) => {
    if (!access.unlocked) return;
    const pending = pendingExport.current.take();
    if (!pending) return;
    setPaywallOpen(false);
    try {
      await pending();
    } catch (error) {
      // The purchase has already succeeded at this point. Keep that truth in
      // the UI even if the exact Save/Share action being resumed then fails.
      setState(current => ({ ...current, error: asError(error) }));
    }
  }, []);

  useEffect(() => {
    if (!native) return;
    let active = true;
    let listener: { remove(): Promise<void> } | null = null;
    void Promise.allSettled([native.getProducts(), native.getAccessState()])
      .then(([productsResult, accessResult]) => {
        if (!active) return;
        const error = productsResult.status === 'rejected'
          ? asError(productsResult.reason)
          : accessResult.status === 'rejected'
            ? asError(accessResult.reason)
            : null;
        setState({
          available: true,
          loading: false,
          products: productsResult.status === 'fulfilled' ? productsResult.value.products : [],
          access: accessResult.status === 'fulfilled' ? accessResult.value : null,
          error,
        });
      });
    void native.addListener('accessChanged', access => {
      if (!active) return;
      applyAccess(access);
      void resumePendingExport(access).catch(() => undefined);
    }).then(handle => {
      if (active) listener = handle;
      else void handle.remove();
    }).catch(() => undefined);
    return () => {
      active = false;
      if (listener) void listener.remove();
    };
  }, [applyAccess, native, resumePendingExport]);

  useEffect(() => {
    if (!native) return;
    return installOutputAccessHandler(async request => {
      try {
        const access = await native.getAccessState();
        applyAccess(access);
        if (access.unlocked) return { status: 'deliver' } satisfies OutputAccessDisposition;
        const job = await native.recordFreeJob({ operationId: request.operationId });
        applyAccess(job.access);
        // The first five native jobs stay full-featured. Later results are still
        // generated, but exist only as an in-app preview and never trigger a popup.
        return job.status === 'allowed'
          ? { status: 'deliver' } satisfies OutputAccessDisposition
          : { status: 'preview' } satisfies OutputAccessDisposition;
      } catch (error) {
        // Once the native purchase authority is present, an unreadable quota
        // must fail closed for external delivery. The exact bytes still reach
        // OutputCenter as an in-memory preview, so no work is lost and no
        // unverified entitlement can save or share a result.
        setState(current => ({ ...current, error: asError(error) }));
        return { status: 'preview' } satisfies OutputAccessDisposition;
      }
    });
  }, [applyAccess, native]);

  const requestUnlock = useCallback(async () => {
    if (!native) return true;
    const access = stateRef.current.access ?? await native.getAccessState();
    applyAccess(access);
    if (access.unlocked || access.freeJobsRemaining > 0) return true;
    setPaywallOpen(true);
    return false;
  }, [applyAccess, native]);

  const completeJob = useCallback(async (operationId: string): Promise<JobAccessGrant> => {
    if (!native) return 'full';
    const access = await native.getAccessState();
    applyAccess(access);
    if (access.unlocked) return 'pro';
    const job = await native.recordFreeJob({ operationId });
    applyAccess(job.access);
    return job.status === 'allowed' ? 'full' : 'preview-only';
  }, [applyAccess, native]);

  const runWithExportAccess = useCallback(async <T,>(
    operation: () => Promise<T> | T,
    options?: { operationId?: string },
  ): Promise<ExportAccessResult<T>> => {
    const operationId = options?.operationId;
    if (!native) return { status: 'completed', value: await operation() };
    const pending = pendingExport.current;
    const request = pending.begin(operationId);
    let allowed: boolean;
    try {
      if (!operationId) {
        allowed = await requestUnlock();
      } else {
        const authorization = await authorizeExport(native, stateRef.current.access, operationId);
        applyAccess(authorization.access);
        allowed = authorization.allowed;
      }
    } catch (error) {
      pending.finish(request);
      throw error;
    }
    if (allowed) {
      pending.finish(request);
      return { status: 'completed', value: await operation() };
    }
    // A result discarded while its access was checked neither opens the paywall nor waits there.
    if (pending.hold(request, async () => operation()) && operationId) setPaywallOpen(true);
    return { status: 'blocked' };
  }, [applyAccess, native, requestUnlock]);

  const cancelPendingExport = useCallback((operationId?: string) => {
    pendingExport.current.cancel(operationId);
  }, []);

  const dismissPaywall = useCallback(() => {
    pendingExport.current.cancel();
    setPaywallOpen(false);
  }, []);

  const purchase = useCallback(async (productId: string) => {
    if (!native) throw new LocalizedError("monetization.purchases.are.unavailable.in.this.runtime.52bf4b");
    const result = await native.purchase({ productId });
    applyAccess(result.access);
    if (result.status === 'purchased') await resumePendingExport(result.access);
    return result;
  }, [applyAccess, native, resumePendingExport]);

  const restore = useCallback(async () => {
    if (!native) throw new LocalizedError("monetization.purchases.are.unavailable.in.this.runtime.52bf4b");
    const { access } = await native.restore();
    applyAccess(access);
    await resumePendingExport(access);
    return access;
  }, [applyAccess, native, resumePendingExport]);

  const manageSubscriptions = useCallback(async () => {
    if (!native) return;
    await native.manageSubscriptions();
  }, [native]);

  const value = useMemo<MonetizationContextValue>(() => ({
    ...state,
    canExport: !state.available || Boolean(state.access?.unlocked) || (state.access?.freeJobsRemaining ?? 0) > 0,
    freeRemaining: state.available ? state.access?.freeJobsRemaining ?? null : null,
    freeResetDate: state.available ? state.access?.freeWindowEndsAt ?? null : null,
    paywallOpen,
    dismissPaywall,
    showPaywall: () => setPaywallOpen(true),
    requestUnlock,
    completeJob,
    runWithExportAccess,
    cancelPendingExport,
    purchase,
    restore,
    manageSubscriptions,
  }), [cancelPendingExport, completeJob, dismissPaywall, manageSubscriptions, paywallOpen, purchase, requestUnlock, restore, runWithExportAccess, state]);

  return <MonetizationContext.Provider value={value}>{children}</MonetizationContext.Provider>;
};

export const useMonetizationContext = (): MonetizationContextValue => {
  const context = useContext(MonetizationContext);
  if (!context) throw new LocalizedError("monetization.usemonetization.must.be.used.within.monetizationprovider.db0324");
  return context;
};
