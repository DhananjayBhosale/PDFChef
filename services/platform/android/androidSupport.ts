import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * Optional support through Google Play. Every tool stays free for everyone; a support payment
 * unlocks nothing. "unavailable" means Play has no products to offer, so no support is shown.
 */
export type SupportPlan = 'monthly' | 'lifetime';

export interface AndroidSupportState {
  readonly status: 'ready' | 'unavailable';
  readonly monthlyPrice: string | null;
  readonly lifetimePrice: string | null;
  readonly supporter: 'none' | SupportPlan;
  readonly pending: boolean;
}

export type SupportResult = 'supported' | 'pending' | 'cancelled' | 'unavailable';

export interface AndroidSupportNativePlugin {
  getSupport(): Promise<unknown>;
  support(options: { plan: SupportPlan }): Promise<unknown>;
  manageSupport(): Promise<unknown>;
}

const AndroidSupportNative = registerPlugin<AndroidSupportNativePlugin>('AndroidSupport');

export const isAndroidSupportAvailable = (): boolean =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('AndroidSupport');

const invalidResponse = (): TypeError => new TypeError('Android support response is invalid.');

const exactObject = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw invalidResponse();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw invalidResponse();
  }
  return value as Record<string, unknown>;
};

const isPrice = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && value.trim().length > 0 && value.length <= 64);

const parseState = (value: unknown): AndroidSupportState => {
  const record = exactObject(value, ['lifetimePrice', 'monthlyPrice', 'pending', 'status', 'supporter']);
  const { status, monthlyPrice, lifetimePrice, supporter, pending } = record;
  if ((status !== 'ready' && status !== 'unavailable')
      || !isPrice(monthlyPrice) || !isPrice(lifetimePrice)
      || (supporter !== 'none' && supporter !== 'monthly' && supporter !== 'lifetime')
      || typeof pending !== 'boolean') throw invalidResponse();
  return Object.freeze({ status, monthlyPrice, lifetimePrice, supporter, pending });
};

const parseResult = (value: unknown): SupportResult => {
  const { status } = exactObject(value, ['status']);
  if (status !== 'supported' && status !== 'pending' && status !== 'cancelled' && status !== 'unavailable') {
    throw invalidResponse();
  }
  return status;
};

export class AndroidSupportClient {
  private readonly native: AndroidSupportNativePlugin;

  /** Runtime callers use the registered proxy; injection exists only for isolated contract tests. */
  constructor(native: AndroidSupportNativePlugin = AndroidSupportNative) {
    this.native = native;
  }

  async getSupport(): Promise<AndroidSupportState> {
    return parseState(await this.native.getSupport());
  }

  async support(plan: SupportPlan): Promise<SupportResult> {
    return parseResult(await this.native.support({ plan }));
  }

  async manageSupport(): Promise<void> {
    const { status } = exactObject(await this.native.manageSupport(), ['status']);
    if (status !== 'opened') throw invalidResponse();
  }
}
