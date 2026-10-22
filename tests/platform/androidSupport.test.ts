import assert from 'node:assert/strict';
import test from 'node:test';
import { AndroidSupportClient, type AndroidSupportNativePlugin } from '../../services/platform/android/androidSupport.ts';

const ready = { status: 'ready', monthlyPrice: '₹29.00', yearlyPrice: '₹299.00', lifetimePrice: '₹499.00', supporter: 'none', pending: false };

const nativeStub = (overrides: Partial<AndroidSupportNativePlugin> = {}): AndroidSupportNativePlugin => ({
  getSupport: async () => ready,
  support: async () => ({ status: 'supported' }),
  manageSupport: async () => ({ status: 'opened' }),
  ...overrides,
});

test('state accepts exactly the six public fields and is frozen', async () => {
  const state = await new AndroidSupportClient(nativeStub()).getSupport();
  assert.deepEqual(state, ready);
  assert.equal(Object.isFrozen(state), true);

  const unavailable = { status: 'unavailable', monthlyPrice: null, yearlyPrice: null, lifetimePrice: null, supporter: 'none', pending: false };
  const subscriber = { ...ready, supporter: 'subscriber' };
  assert.deepEqual(await new AndroidSupportClient(nativeStub({ getSupport: async () => subscriber })).getSupport(), subscriber);
  assert.deepEqual(await new AndroidSupportClient(nativeStub({ getSupport: async () => unavailable })).getSupport(), unavailable);
});

test('state rejects extra keys, unknown values and blank prices', async () => {
  for (const reply of [
    { ...ready, unlocked: true },
    { ...ready, status: 'loading' },
    { ...ready, supporter: 'pro' },
    { ...ready, supporter: 'monthly' },
    { ...ready, yearlyPrice: '' },
    { ...ready, monthlyPrice: ' ' },
    { ...ready, lifetimePrice: 899 },
    { ...ready, pending: 'no' },
    null,
    [ready],
  ]) {
    await assert.rejects(new AndroidSupportClient(nativeStub({ getSupport: async () => reply })).getSupport(), TypeError);
  }
});

test('support sends only the plan and returns the Play outcome', async () => {
  const plans: unknown[] = [];
  const client = new AndroidSupportClient(nativeStub({
    support: async (options) => {
      plans.push(options);
      return { status: 'pending' };
    },
  }));
  assert.equal(await client.support('yearly'), 'pending');
  assert.deepEqual(plans, [{ plan: 'yearly' }]);
  await assert.rejects(
    new AndroidSupportClient(nativeStub({ support: async () => ({ status: 'unlocked' }) })).support('lifetime'),
    TypeError,
  );
});

test('manage requires the opened reply', async () => {
  await new AndroidSupportClient(nativeStub()).manageSupport();
  await assert.rejects(
    new AndroidSupportClient(nativeStub({ manageSupport: async () => ({ status: 'opened', url: 'x' }) })).manageSupport(),
    TypeError,
  );
});
