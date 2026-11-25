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

// h3 F1: the save picker needs a user gesture, and a job ends long after the tap that started it.
// An automatic save must download at once, also in browsers that have the picker.
const installPickerSpy = () => {
  let opened = 0;
  (globalThis.window as unknown as { showSaveFilePicker: () => Promise<never> }).showSaveFilePicker = async () => {
    opened += 1;
    throw new DOMException('no user gesture', 'SecurityError');
  };
  return () => opened;
};

test('awaitable automatic save downloads at once and never opens the save picker', async () => {
  const browser = installBrowserHarness({ keepLocalHistory: false, autoDownload: true });
  const pickerOpened = installPickerSpy();
  try {
    assert.deepEqual(await deliverBlob(new Blob(['result']), 'result.pdf', 'application/pdf'), { status: 'delivered' });
    assert.equal(pickerOpened(), 0);
    assert.deepEqual(browser.clicks, [{ href: 'blob:test-1', download: 'result.pdf' }]);
    assert.equal(browser.events.length, 1);
    assert.equal((browser.events[0].detail as OutputReadyRecord).deliveryIssue, undefined);
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

test('fire-and-forget automatic save downloads at once and never opens the save picker', async () => {
  const browser = installBrowserHarness();
  const pickerOpened = installPickerSpy();
  const blob = new Blob([new Uint8Array([0, 1, 255])]);
  try {
    assert.equal(downloadBlob(blob, 'result.pdf', 'application/pdf'), 'blob:test-1');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(pickerOpened(), 0);
    assert.deepEqual(browser.clicks, [{ href: 'blob:test-1', download: 'result.pdf' }]);
    assert.equal(browser.events.length, 1);
    const ready = browser.events[0].detail as OutputReadyRecord;
    assert.equal(ready.blob, blob);
    assert.equal(ready.deliveryIssue, undefined);
  } finally {
    browser.restore();
  }
});

// Node has no IndexedDB, so keeping a result in history fails before a write can occur.
const withWarningsCounted = async (run: () => Promise<void>) => {
  const warning = console.warn;
  let warnings = 0;
  console.warn = () => { warnings += 1; };
  try {
    await run();
  } finally {
    console.warn = warning;
  }
  return warnings;
};

test('unavailable browser history still delivers the result, only not kept, so the tool and sheet agree', async () => {
  const browser = installBrowserHarness({ keepLocalHistory: true, autoDownload: false });
  const blob = new Blob(['private output']);
  try {
    const warnings = await withWarningsCounted(async () => {
      assert.deepEqual(await deliverBlob(blob, 'result.pdf', 'application/pdf'), { status: 'delivered' });
    });
    assert.equal(warnings, 1, 'the history failure is logged, not swallowed');
    assert.equal(browser.events.length, 1);
    const ready = browser.events[0].detail as OutputReadyRecord;
    assert.equal(ready.blob, blob);
    assert.equal(ready.deliveryIssue, undefined, 'a history failure must not read as a failed save');
    assert.equal(ready.historyRetained, false);
    assert.deepEqual(browser.created, []);
  } finally {
    browser.restore();
  }
});

test('fire-and-forget delivery with unavailable history announces a ready, unkept result', async () => {
  const browser = installBrowserHarness({ keepLocalHistory: true, autoDownload: false });
  const blob = new Blob(['private output']);
  try {
    await withWarningsCounted(async () => {
      assert.equal(downloadBlob(blob, 'result.pdf', 'application/pdf'), null);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.equal(browser.events.length, 1);
    const ready = browser.events[0].detail as OutputReadyRecord;
    assert.equal(ready.blob, blob);
    assert.equal(ready.deliveryIssue, undefined);
    assert.equal(ready.historyRetained, false);
  } finally {
    browser.restore();
  }
});

test('an automatic save with unavailable history still downloads and reads as delivered, not kept', async () => {
  const browser = installBrowserHarness({ keepLocalHistory: true, autoDownload: true });
  const pickerOpened = installPickerSpy();
  try {
    await withWarningsCounted(async () => {
      assert.deepEqual(await deliverBlob(new Blob(['result']), 'result.pdf', 'application/pdf'), { status: 'delivered' });
    });
    assert.equal(pickerOpened(), 0);
    assert.equal(browser.clicks.length, 1);
    assert.equal(browser.events.length, 1);
    const ready = browser.events[0].detail as OutputReadyRecord;
    assert.equal(ready.deliveryIssue, undefined);
    assert.equal(ready.historyRetained, false);
  } finally {
    browser.restore();
  }
});

test('a Split set to separate PDFs keeps and announces its ZIP without downloading it', async () => {
  const browser = installBrowserHarness();
  const blob = new Blob([new Uint8Array([80, 75, 3, 4])], { type: 'application/zip' });
  const folder = { name: 'Splits' } as unknown as FileSystemDirectoryHandle;
  try {
    assert.equal(downloadBlob(blob, 'report-split.zip', 'application/zip', { separateSave: { folder } }), null);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(browser.clicks, [], 'the ZIP is not saved; the strip saves its parts');
    assert.equal(browser.events.length, 1);
    const ready = browser.events[0].detail as OutputReadyRecord;
    assert.equal(ready.blob, blob, 'the ZIP stays the result');
    assert.equal(ready.externallyExported, false);
    assert.equal(ready.separateSave?.folder, folder, 'the folder picked at the tap travels with it');
  } finally {
    browser.restore();
  }
});

test('the native handler is told not to export a ZIP whose parts are saved separately', async () => {
  const browser = installBrowserHarness({ keepLocalHistory: true, autoDownload: true });
  const requests: Parameters<OutputDeliveryHandler>[0][] = [];
  const uninstall = installOutputDeliveryHandler(async request => { requests.push(request); });
  const blob = new Blob([new Uint8Array([80, 75, 3, 4])], { type: 'application/zip' });
  try {
    downloadBlob(blob, 'report-split.zip', 'application/zip', { separateSave: {} });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].autoDownload, false);
    assert.equal(requests[0].keepLocalHistory, true, 'Recent still keeps the ZIP');
    const ready = browser.events[0].detail as OutputReadyRecord;
    assert.deepEqual(ready.separateSave, {});
    assert.equal(ready.externallyExported, false);
  } finally {
    uninstall();
    browser.restore();
  }
});

// s2-07 (overnight A1): whether a browser result was exported comes from its delivery, never from
// a setting read after it. Automatic download is off when the job ends and turned on (another tab)
// before the event; the history write is rejected (Node has no IndexedDB).
const turnedOnAfterFirstRead = () => {
  let reads = 0;
  return { keepLocalHistory: true, get autoDownload() { reads += 1; return reads > 1; } };
};

test('a browser result that was not downloaded says so itself, whatever the setting reads later', async () => {
  const browser = installBrowserHarness(turnedOnAfterFirstRead());
  try {
    await withWarningsCounted(async () => {
      assert.equal(downloadBlob(new Blob(['only copy']), 'result.pdf', 'application/pdf'), null);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.deepEqual(browser.clicks, [], 'nothing was downloaded');
    assert.equal(browser.events.length, 1);
    const ready = browser.events[0].detail as OutputReadyRecord;
    assert.equal(ready.historyRetained, false, 'the history write was rejected');
    assert.equal(ready.externallyExported, false, 'not exported, said by the delivery');
  } finally {
    browser.restore();
  }
});

test('the awaitable browser delivery says the same', async () => {
  const browser = installBrowserHarness(turnedOnAfterFirstRead());
  try {
    await withWarningsCounted(async () => {
      assert.deepEqual(await deliverBlob(new Blob(['only copy']), 'result.pdf', 'application/pdf'), { status: 'delivered' });
    });
    assert.deepEqual(browser.clicks, []);
    const ready = browser.events[0].detail as OutputReadyRecord;
    assert.equal(ready.externallyExported, false);
  } finally {
    browser.restore();
  }
});

test('a browser result that was downloaded says so', async () => {
  for (const deliver of ['downloadBlob', 'deliverBlob'] as const) {
    const browser = installBrowserHarness({ keepLocalHistory: false, autoDownload: true });
    try {
      if (deliver === 'downloadBlob') {
        downloadBlob(new Blob(['result']), 'result.pdf', 'application/pdf');
        await new Promise(resolve => setTimeout(resolve, 0));
      } else {
        await deliverBlob(new Blob(['result']), 'result.pdf', 'application/pdf');
      }
      assert.equal(browser.clicks.length, 1, deliver);
      assert.equal((browser.events[0].detail as OutputReadyRecord).externallyExported, true, deliver);
    } finally {
      browser.restore();
    }
  }
});
