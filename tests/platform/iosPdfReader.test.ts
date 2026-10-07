import assert from 'node:assert/strict';
import test from 'node:test';
import type { DurableDocumentRef, StoredDocument } from '../../services/domain/workspaceModels.ts';
import {
  createIOSPdfReaderService,
  IOS_MAXIMUM_SIGNATURE_VERIFICATION_BYTES,
  IOSSignatureVerificationSizeError,
  IOS_MAXIMUM_WEB_HANDOFF_BYTES,
  isEligibleIOSPdf,
} from '../../services/platform/capacitor/iosPdfReader.ts';

const pdf = (overrides: Partial<StoredDocument> = {}): StoredDocument => ({
  ref: 'A1b2_C3-d4' as DurableDocumentRef,
  name: 'Large document.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 512 * 1024 * 1024,
  contentHash: null,
  retainedAt: 1,
  ...overrides,
});

test('iOS native reader keeps large durable PDFs on the file-backed path', async () => {
  const calls: Array<{ ref: DurableDocumentRef; name: string }> = [];
  const service = createIOSPdfReaderService({
    async openReader(ref, name) {
      calls.push({ ref, name });
      return { action: 'closed' };
    },
  });

  assert.equal(isEligibleIOSPdf(pdf()), true);
  assert.deepEqual(await service.open(pdf()), { action: 'closed' });
  assert.deepEqual(calls, [{ ref: pdf().ref, name: 'Large document.pdf' }]);
});

test('iOS native reader rejects non-PDFs and non-allowlisted tool handoffs', async () => {
  assert.equal(isEligibleIOSPdf(pdf({ mimeType: 'image/png', name: 'image.png' })), false);
  const service = createIOSPdfReaderService({
    async openReader() { return { action: 'tool', toolPath: '/settings' }; },
  });
  await assert.rejects(service.open(pdf()), /invalid action/);
});

test('iOS native reader treats native large-PDF batching as a closed reader session', async () => {
  const service = createIOSPdfReaderService({
    async openReader() { return { action: 'batched', partCount: 7 }; },
  });

  assert.deepEqual(await service.open(pdf()), { action: 'closed' });

  const invalid = createIOSPdfReaderService({
    async openReader() { return { action: 'batched', partCount: 65 }; },
  });
  await assert.rejects(invalid.open(pdf()), /invalid action/);
});

test('iOS native reader never sends a PDF over 200 MiB to the web fallback', async () => {
  const launchError = new Error('native reader unavailable');
  const service = createIOSPdfReaderService({
    async openReader() { throw launchError; },
  });

  assert.deepEqual(await service.open(pdf({
    sizeBytes: IOS_MAXIMUM_WEB_HANDOFF_BYTES + 1,
  })), { action: 'closed' });
  await assert.rejects(
    service.open(pdf({ sizeBytes: IOS_MAXIMUM_WEB_HANDOFF_BYTES })),
    (error: unknown) => error === launchError,
  );
});

test('iOS signature action opens the existing native report without launching the reader', async () => {
  const reports: Array<{ ref: DurableDocumentRef; name: string | null }> = [];
  let readerLaunches = 0;
  const service = createIOSPdfReaderService({
    async openReader() {
      readerLaunches += 1;
      return { action: 'closed' };
    },
    async presentSignatureReport(ref, name) {
      reports.push({ ref, name });
    },
  }, {
    isSignatureVerificationAvailable: () => true,
  });

  assert.equal(service.supportsSignatureVerification, true);
  assert.deepEqual(
    await service.open(pdf({ sizeBytes: IOS_MAXIMUM_SIGNATURE_VERIFICATION_BYTES }), {
      initialAction: 'verify-signatures',
    }),
    { action: 'closed' },
  );
  assert.deepEqual(reports, [{ ref: pdf().ref, name: 'Large document.pdf' }]);
  assert.equal(readerLaunches, 0);
});

test('iOS signature action fails closed when unavailable or over its size limit', async () => {
  assert.equal(IOS_MAXIMUM_SIGNATURE_VERIFICATION_BYTES, 64 * 1024 * 1024);
  let reports = 0;
  const bridge = {
    async openReader() { return { action: 'closed' } as const; },
    async presentSignatureReport() { reports += 1; },
  };
  const unavailable = createIOSPdfReaderService(bridge);
  assert.equal(unavailable.supportsSignatureVerification, false);
  await assert.rejects(
    unavailable.open(pdf(), { initialAction: 'verify-signatures' }),
    /unavailable/,
  );

  const available = createIOSPdfReaderService(bridge, {
    isSignatureVerificationAvailable: () => true,
  });
  await assert.rejects(
    available.open(pdf({
      sizeBytes: IOS_MAXIMUM_SIGNATURE_VERIFICATION_BYTES + 1,
    }), { initialAction: 'verify-signatures' }),
    IOSSignatureVerificationSizeError,
  );
  assert.equal(reports, 0);
});
