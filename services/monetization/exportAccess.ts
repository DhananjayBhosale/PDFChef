import type {
  PdfChefPurchaseAccess,
  PdfChefPurchasesNativePlugin,
} from '../platform/capacitor/pdfChefPurchases.ts';

export interface ExportAuthorization {
  allowed: boolean;
  access: PdfChefPurchaseAccess;
}

/**
 * Decides whether one export may leave the app on native iOS. A generated result is
 * authorized by its own operation ID against fresh native state, so a cached free count
 * can never stand in for recording its job. Actions without a result keep the cached
 * answer because they create nothing that could be saved or shared.
 */
export const authorizeExport = async (
  native: Pick<PdfChefPurchasesNativePlugin, 'getAccessState' | 'recordFreeJob'>,
  cached: PdfChefPurchaseAccess | null,
  operationId?: string,
): Promise<ExportAuthorization> => {
  if (!operationId) {
    const access = cached ?? await native.getAccessState();
    return { allowed: access.unlocked || access.freeJobsRemaining > 0, access };
  }
  const access = await native.getAccessState();
  if (access.unlocked) return { allowed: true, access };
  const job = await native.recordFreeJob({ operationId });
  return { allowed: job.status === 'allowed', access: job.access };
};

/**
 * The one export waiting behind the paywall, remembered with the result it belongs to.
 * Each request is begun before authorization, so a result discarded while its access is
 * still being checked is never held for a later purchase.
 */
export class PendingExport {
  private readonly live = new Map<object, string | undefined>();
  private held: { run: () => Promise<unknown>; operationId?: string } | null = null;

  begin(operationId?: string): object {
    const request = {};
    this.live.set(request, operationId);
    return request;
  }

  /** Ends a request that no longer needs the paywall. */
  finish(request: object): void {
    this.live.delete(request);
  }

  /** Holds the request's export, unless its result was discarded after it began. */
  hold(request: object, run: () => Promise<unknown>): boolean {
    if (!this.live.has(request)) return false;
    const operationId = this.live.get(request);
    this.live.delete(request);
    this.held = { run, operationId };
    return true;
  }

  /** Forgets waiting and in-flight exports; given an operation ID, only those for that result. */
  cancel(operationId?: string): void {
    for (const [request, id] of this.live) {
      if (!operationId || id === operationId) this.live.delete(request);
    }
    if (!operationId || this.held?.operationId === operationId) this.held = null;
  }

  take(): (() => Promise<unknown>) | null {
    const run = this.held?.run ?? null;
    this.held = null;
    return run;
  }
}
