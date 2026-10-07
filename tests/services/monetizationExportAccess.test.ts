import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingExport, authorizeExport } from '../../services/monetization/exportAccess.ts';
import type { PdfChefPurchaseAccess } from '../../services/platform/capacitor/pdfChefPurchases.ts';

const access = (overrides: Partial<PdfChefPurchaseAccess> = {}): PdfChefPurchaseAccess => ({
  unlocked: false,
  lifetimeOwned: false,
  monthlyActive: false,
  monthlyExpirationDate: null,
  freeJobsRemaining: 0,
  freeWindowEndsAt: null,
  ...overrides,
});

const nativeQuota = (native: PdfChefPurchaseAccess, status: 'allowed' | 'exhausted') => {
  const recorded: string[] = [];
  return {
    recorded,
    plugin: {
      getAccessState: async () => native,
      recordFreeJob: async ({ operationId }: { operationId: string }) => {
        recorded.push(operationId);
        return { status, access: native };
      },
    },
  };
};

test('saving a preview after the allowance renews records that preview as a job', async () => {
  const { plugin, recorded } = nativeQuota(access({ freeJobsRemaining: 5 }), 'allowed');

  const result = await authorizeExport(plugin, access({ freeJobsRemaining: 5 }), 'preview-operation');

  assert.equal(result.allowed, true);
  assert.deepEqual(recorded, ['preview-operation'], 'a cached free count must not replace recording the job');
});

test('a stale cached free count cannot export a preview once native quota is spent', async () => {
  const { plugin, recorded } = nativeQuota(access({ freeJobsRemaining: 0 }), 'exhausted');

  const result = await authorizeExport(plugin, access({ freeJobsRemaining: 3 }), 'preview-operation');

  assert.equal(result.allowed, false);
  assert.deepEqual(recorded, ['preview-operation']);
  assert.equal(result.access.freeJobsRemaining, 0, 'the fresh native answer replaces the cached one');
});

test('an active entitlement exports without spending a free job', async () => {
  const { plugin, recorded } = nativeQuota(access({ unlocked: true, lifetimeOwned: true }), 'exhausted');

  const result = await authorizeExport(plugin, null, 'preview-operation');

  assert.equal(result.allowed, true);
  assert.deepEqual(recorded, []);
});

test('an export abandoned at the paywall never runs after a later purchase', async () => {
  const pending = new PendingExport();
  const save = async () => undefined;

  assert.equal(pending.hold(pending.begin('result-a'), save), true);
  pending.cancel();
  assert.equal(pending.take(), null);

  assert.equal(pending.hold(pending.begin('result-a'), save), true);
  pending.cancel('result-b');
  assert.notEqual(pending.take(), null, "discarding a different result keeps this result's save");

  assert.equal(pending.hold(pending.begin('result-a'), save), true);
  pending.cancel('result-a');
  assert.equal(pending.take(), null, 'discarding the originating result drops its save');
});

test('a result discarded while its access is checked is never held for a later purchase', async () => {
  const pending = new PendingExport();
  const save = async () => undefined;

  const discarded = pending.begin('result-a');
  const other = pending.begin('result-b');
  pending.cancel('result-a');

  assert.equal(pending.hold(discarded, save), false, 'the late refusal must not queue the discarded save');
  assert.equal(pending.take(), null);
  assert.equal(pending.hold(other, save), true, "another result's request is unaffected");
  assert.notEqual(pending.take(), null);

  const finished = pending.begin('result-c');
  pending.finish(finished);
  assert.equal(pending.hold(finished, save), false, 'a finished request cannot be held');
});
