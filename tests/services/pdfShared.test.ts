import assert from 'node:assert/strict';
import test from 'node:test';
import type { OutputDeliveryHandler } from '../../services/platform/contracts.ts';
import { deliverBlob, downloadBlob, installOutputDeliveryHandler, type OutputReadyRecord } from '../../services/pdfShared.ts';
import { OUTPUT_EVENT } from '../../services/workspace.ts';

interface BrowserHarness {
  events: Array<{ type: string; detail: unknown }>;
  clicks: Array<{ href: string; download: string }>;
  created: Blob[];
  settingsReads(): number;
  restore(): void;
}

const installBrowserHarness = (settings = {
  keepLocalHistory: false,
  autoDownload: true,
}): BrowserHarness => {
  const descriptors = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    createObjectURL: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
    revokeObjectURL: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL'),
  };
  const events: BrowserHarness['events'] = [];
  const clicks: BrowserHarness['clicks'] = [];
  const created: Blob[] = [];
  let reads = 0;
  const link = { href: '', download: '', click() { clicks.push({ href: link.href, download: link.download }); } };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { pathname: '/watermark-pdf' },
      localStorage: {
        getItem() {
          reads += 1;
          return JSON.stringify(settings);
        },
      },
      dispatchEvent(event: CustomEvent) {
        events.push({ type: event.type, detail: event.detail });
        return true;
      },
      setTimeout,
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => link },
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      created.push(blob);
      return `blob:test-${created.length}`;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });

  return {
    events,
    clicks,
    created,
    settingsReads: () => reads,
    restore() {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        const target = key === 'createObjectURL' || key === 'revokeObjectURL' ? URL : globalThis;
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete (target as unknown as Record<string, unknown>)[key];
      }
    },
  };
};

test('native handler receives one exact request and announces the Blob after successful delivery', async () => {
  const browser = installBrowserHarness({ keepLocalHistory: true, autoDownload: false });
  const requests: Parameters<OutputDeliveryHandler>[0][] = [];
  const uninstall = installOutputDeliveryHandler(async request => { requests.push(request); });
  const blob = new Blob([new Uint8Array([0, 99, 255])], { type: 'application/pdf' });
  try {
    assert.equal(downloadBlob(blob, 'precise.pdf', ''), null);
    assert.equal(browser.events.length, 0, 'announcement waits for delivery success');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(browser.events.length, 1);
    assert.equal(browser.events[0].type, OUTPUT_EVENT);
    assert.equal((browser.events[0].detail as { blob: Blob }).blob, blob);
    assert.deepEqual(requests, [{
      blob,
      name: 'precise.pdf',
      mimeType: 'application/pdf',
      toolPath: '/watermark-pdf',
      keepLocalHistory: true,
      autoDownload: false,
    }]);
    assert.equal(browser.settingsReads(), 1);
    assert.deepEqual(browser.created, []);
  } finally {
    uninstall();
    browser.restore();
  }
});

test('awaitable native failure rejects while retaining the exact bytes only in the retry event', async () => {
  const browser = installBrowserHarness({ keepLocalHistory: false, autoDownload: true });
  const uninstall = installOutputDeliveryHandler(async () => { throw new Error('native failed'); });
  try {
    await assert.rejects(
      deliverBlob(new Blob(['recoverable']), 'recoverable.pdf', 'application/pdf'),
      /native failed/,
    );
    assert.equal(browser.events.length, 1);
    const retry = browser.events[0].detail as OutputReadyRecord;
    assert.equal(retry.deliveryIssue, 'failed');
    assert.equal(retry.historyRetained, false);
    assert.equal(await retry.blob!.text(), 'recoverable');
    assert.deepEqual(browser.created, []);
  } finally {
    uninstall();
    browser.restore();
  }
});

test('awaitable browser delivery announces an unretained result when automatic save is off', async () => {
  const browser = installBrowserHarness({ keepLocalHistory: false, autoDownload: false });
  const blob = new Blob(['result'], { type: 'application/pdf' });
  try {
    await deliverBlob(blob, 'result.pdf', 'application/pdf');
    assert.equal(browser.events.length, 1);
    assert.equal((browser.events[0].detail as { blob: Blob }).blob, blob);
    assert.deepEqual(browser.clicks, []);
  } finally {
    browser.restore();
  }
});

test('awaitable browser delivery keeps the result dirty when an unretained picker is cancelled', async () => {
  const browser = installBrowserHarness({ keepLocalHistory: false, autoDownload: true });
  (globalThis.window as unknown as { showSaveFilePicker: () => Promise<never> }).showSaveFilePicker = async () => {
    throw new DOMException('cancelled', 'AbortError');
  };
  try {
    await assert.rejects(
      deliverBlob(new Blob(['result']), 'result.pdf', 'application/pdf'),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    assert.equal(browser.events.length, 1);
    const retry = browser.events[0].detail as OutputReadyRecord;
    assert.equal(retry.deliveryIssue, 'cancelled');
    assert.equal(retry.historyRetained, false);
    assert.equal(await retry.blob!.text(), 'result');
    assert.deepEqual(browser.clicks, []);
  } finally {
    browser.restore();
  }
});

test('installer cleanup is identity-safe even when the same function is reinstalled', async () => {
  const browser = installBrowserHarness();
  let calls = 0;
  const handler: OutputDeliveryHandler = async () => { calls += 1; };
  const disposeOlder = installOutputDeliveryHandler(handler);
  const disposeCurrent = installOutputDeliveryHandler(handler);
  try {
    disposeOlder();
    downloadBlob(new Blob(['one']), 'one.pdf', 'application/pdf');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 1);
    disposeCurrent();

    const fallback = downloadBlob(new Blob(['two']), 'two.pdf', 'application/pdf');
    assert.equal(fallback, 'blob:test-1');
    assert.deepEqual(browser.clicks, [{ href: 'blob:test-1', download: 'two.pdf' }]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(browser.events.length, 2, 'native and browser paths each announce exactly once');
  } finally {
    disposeOlder();
    disposeCurrent();
    browser.restore();
  }
});

test('fire-and-forget handler rejection exposes an unretained retry without a browser download', async () => {
  const browser = installBrowserHarness();
  const warning = console.warn;
  let warnings = 0;
  console.warn = () => { warnings += 1; };
  const uninstall = installOutputDeliveryHandler(async () => { throw new Error('native failed'); });
  const blob = new Blob(['recoverable']);
  try {
    downloadBlob(blob, 'recoverable.pdf', 'application/pdf');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(browser.events.length, 1);
    const retry = browser.events[0].detail as OutputReadyRecord;
    assert.equal(retry.blob, blob);
    assert.equal(retry.deliveryIssue, 'failed');
    assert.equal(retry.historyRetained, false);
    assert.equal(warnings, 1);
    assert.deepEqual(browser.created, []);
  } finally {
    uninstall();
    console.warn = warning;
    browser.restore();
  }
});

test('retained native output stays saved while a cancelled optional export remains retryable', async () => {
  const browser = installBrowserHarness({ keepLocalHistory: true, autoDownload: true });
  const uninstall = installOutputDeliveryHandler(async () => ({ exportIssue: 'cancelled' }));
  const blob = new Blob(['retained']);
  try {
    await deliverBlob(blob, 'retained.pdf', 'application/pdf');
    assert.equal(browser.events.length, 1);
    const retry = browser.events[0].detail as OutputReadyRecord;
    assert.equal(retry.blob, blob);
    assert.equal(retry.deliveryIssue, 'cancelled');
    assert.equal(retry.historyRetained, true);
    assert.deepEqual(browser.created, []);
  } finally {
    uninstall();
    browser.restore();
  }
});

test('fire-and-forget browser cancellation exposes exact bytes without retaining history or falling back', async () => {
  const browser = installBrowserHarness();
  (window as unknown as { showSaveFilePicker: () => Promise<never> }).showSaveFilePicker = async () => {
    throw new DOMException('cancelled', 'AbortError');
  };
  const blob = new Blob([new Uint8Array([0, 1, 255])]);
  try {
    assert.equal(downloadBlob(blob, 'result.pdf', 'application/pdf'), null);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(browser.events.length, 1);
    const retry = browser.events[0].detail as OutputReadyRecord;
    assert.equal(retry.blob, blob);
    assert.equal(retry.deliveryIssue, 'cancelled');
    assert.equal(retry.historyRetained, false);
    assert.deepEqual(browser.created, []);
  } finally {
    browser.restore();
  }
});

test('unavailable browser history leaves a retryable result when automatic saving is off', async () => {
  const browser = installBrowserHarness({ keepLocalHistory: true, autoDownload: false });
  const blob = new Blob(['private output']);
  try {
    // Node has no IndexedDB: persistence fails before a write can occur.
    await assert.rejects(deliverBlob(blob, 'result.pdf', 'application/pdf'));
    assert.equal(browser.events.length, 1);
    const retry = browser.events[0].detail as OutputReadyRecord;
    assert.equal(retry.blob, blob);
    assert.equal(retry.deliveryIssue, 'failed');
    assert.equal(retry.historyRetained, false);
    assert.deepEqual(browser.created, []);
  } finally {
    browser.restore();
  }
});
