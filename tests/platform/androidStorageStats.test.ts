import assert from 'node:assert/strict';
import test from 'node:test';
import { Capacitor } from '@capacitor/core';
import {
  AndroidStorageStatsClient,
  isAndroidStorageStatsAvailable,
  type AndroidStorageStatsNativePlugin,
} from '../../services/platform/android/androidStorageStats.ts';

const nativeStub = (
  implementation: AndroidStorageStatsNativePlugin['getStorageStats'] = async () => ({
    retainedBytes: 0,
    availableBytes: null,
    capacityBytes: null,
    memoryBytes: null,
  }),
): AndroidStorageStatsNativePlugin => ({ getStorageStats: implementation });

test('client requests no arguments and accepts exactly the four public byte fields', async () => {
  let calls = 0;
  const client = new AndroidStorageStatsClient(nativeStub(async (...args) => {
    calls += 1;
    assert.deepEqual(args, []);
    return { retainedBytes: 7, availableBytes: 100, capacityBytes: 200, memoryBytes: 5_900_000_000 };
  }));

  const stats = await client.getStorageStats();
  assert.equal(calls, 1);
  assert.deepEqual(stats, { retainedBytes: 7, availableBytes: 100, capacityBytes: 200, memoryBytes: 5_900_000_000 });
  assert.equal(Object.isFrozen(stats), true);
});

test('nullable filesystem values are accepted without substituting defaults', async () => {
  const stats = await new AndroidStorageStatsClient(nativeStub(async () => ({
    retainedBytes: 0,
    availableBytes: null,
    capacityBytes: null,
    memoryBytes: null,
  }))).getStorageStats();
  assert.deepEqual(stats, { retainedBytes: 0, availableBytes: null, capacityBytes: null, memoryBytes: null });
});

test('response must be a plain exact DTO with safe nonnegative values', async () => {
  const withHiddenField = { retainedBytes: 0, availableBytes: null, capacityBytes: null, memoryBytes: null };
  Object.defineProperty(withHiddenField, 'hiddenPath', { value: '/private/file' });
  const invalid: unknown[] = [
    null,
    [],
    Object.create(null),
    { retainedBytes: 0, availableBytes: null },
    { retainedBytes: 0, availableBytes: null, capacityBytes: null },
    { retainedBytes: 0, availableBytes: null, capacityBytes: null, memoryBytes: null, path: '/private/file' },
    withHiddenField,
    Object.assign({ retainedBytes: 0, availableBytes: null, capacityBytes: null, memoryBytes: null }, { [Symbol('x')]: true }),
    { retainedBytes: -1, availableBytes: null, capacityBytes: null, memoryBytes: null },
    { retainedBytes: 0.5, availableBytes: null, capacityBytes: null, memoryBytes: null },
    { retainedBytes: Number.MAX_SAFE_INTEGER + 1, availableBytes: null, capacityBytes: null, memoryBytes: null },
    { retainedBytes: 0, availableBytes: -1, capacityBytes: null, memoryBytes: null },
    { retainedBytes: 0, availableBytes: null, capacityBytes: Number.NaN, memoryBytes: null },
    { retainedBytes: 0, availableBytes: '0', capacityBytes: null, memoryBytes: null },
    { retainedBytes: 0, availableBytes: 201, capacityBytes: 200, memoryBytes: null },
    { retainedBytes: 0, availableBytes: null, capacityBytes: null, memoryBytes: -1 },
    { retainedBytes: 0, availableBytes: null, capacityBytes: null, memoryBytes: '4' },
  ];

  for (const response of invalid) {
    const client = new AndroidStorageStatsClient(nativeStub(async () => response));
    await assert.rejects(client.getStorageStats(), TypeError);
  }
});

test('native rejection identity is preserved and availability needs Android native discovery', async () => {
  const nativeError = Object.assign(new Error('storage unavailable'), { code: 'STORAGE_STATS_FAILED' });
  const client = new AndroidStorageStatsClient(nativeStub(async () => { throw nativeError; }));
  await assert.rejects(client.getStorageStats(), error => error === nativeError);
  assert.equal(isAndroidStorageStatsAvailable(), false);

  const capacitor = Capacitor as unknown as {
    getPlatform(): string;
    isPluginAvailable(name: string): boolean;
  };
  const getPlatform = capacitor.getPlatform;
  const isPluginAvailable = capacitor.isPluginAvailable;
  try {
    capacitor.getPlatform = () => 'android';
    capacitor.isPluginAvailable = name => name === 'AndroidStorageStats';
    assert.equal(isAndroidStorageStatsAvailable(), true);
    capacitor.isPluginAvailable = () => false;
    assert.equal(isAndroidStorageStatsAvailable(), false);
  } finally {
    capacitor.getPlatform = getPlatform;
    capacitor.isPluginAvailable = isPluginAvailable;
  }
});

test('native contract intentionally exposes getStorageStats only', () => {
  const native = nativeStub();
  assert.deepEqual(Object.keys(native), ['getStorageStats']);

  if (false) {
    // @ts-expect-error Methods beyond storage stats remain separately gated.
    native.stat();
    // @ts-expect-error Methods beyond storage stats remain separately gated.
    native.addListener('storage', () => undefined);
  }
});
