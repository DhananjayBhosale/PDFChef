import { Capacitor, registerPlugin } from '@capacitor/core';

export interface AndroidStorageStatsNativePlugin {
  getStorageStats(): Promise<unknown>;
}

export interface AndroidStorageStats {
  readonly retainedBytes: number;
  readonly availableBytes: number | null;
  readonly capacityBytes: number | null;
  /** Total RAM, so photos can be sized to suit the phone. */
  readonly memoryBytes: number | null;
}

const AndroidStorageStatsNative =
  registerPlugin<AndroidStorageStatsNativePlugin>('AndroidStorageStats');

export const isAndroidStorageStatsAvailable = (): boolean =>
  Capacitor.getPlatform() === 'android'
  && Capacitor.isPluginAvailable('AndroidStorageStats');

const OUTPUT_KEYS = ['availableBytes', 'capacityBytes', 'memoryBytes', 'retainedBytes'] as const;

const invalidResponse = (): TypeError => new TypeError('Android storage stats response is invalid.');

const isPublicByteCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isNullablePublicByteCount = (value: unknown): value is number | null =>
  value === null || isPublicByteCount(value);

const parseStorageStats = (value: unknown): AndroidStorageStats => {
  if (value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalidResponse();
  }

  const record = value as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.some(key => typeof key !== 'string')) throw invalidResponse();
  const keys = (ownKeys as string[]).sort();
  if (keys.length !== OUTPUT_KEYS.length
      || keys.some((key, index) => key !== OUTPUT_KEYS[index])) {
    throw invalidResponse();
  }
  if (!isPublicByteCount(record.retainedBytes)
      || !isNullablePublicByteCount(record.availableBytes)
      || !isNullablePublicByteCount(record.capacityBytes)
      || !isNullablePublicByteCount(record.memoryBytes)
      || (record.availableBytes !== null
        && record.capacityBytes !== null
        && record.availableBytes > record.capacityBytes)) {
    throw invalidResponse();
  }

  return Object.freeze({
    retainedBytes: record.retainedBytes,
    availableBytes: record.availableBytes,
    capacityBytes: record.capacityBytes,
    memoryBytes: record.memoryBytes,
  });
};

export class AndroidStorageStatsClient {
  private readonly native: AndroidStorageStatsNativePlugin;

  /** Runtime callers use the registered proxy; injection exists only for isolated contract tests. */
  constructor(native: AndroidStorageStatsNativePlugin = AndroidStorageStatsNative) {
    this.native = native;
  }

  async getStorageStats(): Promise<AndroidStorageStats> {
    return parseStorageStats(await this.native.getStorageStats());
  }
}
