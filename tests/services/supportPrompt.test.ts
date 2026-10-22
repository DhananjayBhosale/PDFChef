import assert from 'node:assert/strict';
import test from 'node:test';
import type { AndroidSupportState } from '../../services/platform/android/androidSupport.ts';
import { SUPPORT_PROMPT_AFTER_JOBS, isSupportOffered, shouldOfferSupport } from '../../services/supportPrompt.ts';

const ready: AndroidSupportState = { status: 'ready', monthlyPrice: '$0.99', lifetimePrice: '$9.99', supporter: 'none', pending: false };
const eligible = { state: ready, finishedJobs: SUPPORT_PROMPT_AFTER_JOBS, build: '29', promptedBuild: '28' };

test('the prompt waits for ten finished jobs and shows once per app update', () => {
  assert.equal(SUPPORT_PROMPT_AFTER_JOBS, 10);
  assert.equal(shouldOfferSupport(eligible), true);
  assert.equal(shouldOfferSupport({ ...eligible, promptedBuild: null }), true);
  assert.equal(shouldOfferSupport({ ...eligible, finishedJobs: 9 }), false);
  assert.equal(shouldOfferSupport({ ...eligible, promptedBuild: '29' }), false);
  assert.equal(shouldOfferSupport({ ...eligible, build: '' }), false);
});

test('supporters, pending payments and missing Play products are never asked', () => {
  assert.equal(shouldOfferSupport({ ...eligible, state: null }), false);
  assert.equal(shouldOfferSupport({ ...eligible, state: { ...ready, supporter: 'monthly' } }), false);
  assert.equal(shouldOfferSupport({ ...eligible, state: { ...ready, supporter: 'lifetime' } }), false);
  assert.equal(shouldOfferSupport({ ...eligible, state: { ...ready, pending: true } }), false);
  const noProducts: AndroidSupportState = { ...ready, status: 'unavailable', monthlyPrice: null, lifetimePrice: null };
  assert.equal(isSupportOffered(noProducts), false);
  assert.equal(isSupportOffered({ ...ready, monthlyPrice: null }), true);
});
