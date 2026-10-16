import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';

// Current-source component checks: native purchase/storage timing is injected,
// while the application providers, output pipeline and IndexedDB remain real.
const origin = process.env.PDF_CHEF_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({ headless: true });

const withPage = async (route, keepLocalHistory, run) => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  const page = await context.newPage();
  await page.addInitScript(keep => {
    localStorage.setItem('pdfchef.workspace.settings.v1', JSON.stringify({
      autoDownload: false, keepLocalHistory: keep, onboardingComplete: true,
    }));
  }, keepLocalHistory);
  try {
    await page.goto(`${origin}${route}`);
    await page.evaluate(async () => {
      const source = await (await fetch('/App.tsx')).text();
      window.__workspaceModuleUrl = source.match(/from "([^"]*\/hooks\/useWorkspaceRuntime\.tsx[^"]*)"/)[1];
    });
    await run(page);
  } finally {
    await context.close();
  }
};

// Load the same React instance Vite gave the app, including task-local cache URLs.
const installReactHarness = async page => {
  await page.evaluate(async () => {
    const imports = await (await fetch('/index.tsx')).text();
    window.__React = (await import(imports.match(/from "([^"]*\/react\.js[^"]*)"/)[1])).default;
    window.__createRoot = (await import(imports.match(/from "([^"]*\/react-dom_client\.js[^"]*)"/)[1])).default.createRoot;
  });
};

try {
  await withPage('/flatten', false, async page => {
    await page.getByRole('heading', { name: 'Flatten PDF', exact: true }).waitFor();
    await page.evaluate(async () => {
      const { browserPlatform } = await import(window.__workspaceModuleUrl);
      const keep = browserPlatform.keepFresh;
      let firstSave = true;
      browserPlatform.keepFresh = async result => {
        if (firstSave) {
          firstSave = false;
          window.__saveStarted = true;
          await new Promise(resolve => { window.__releaseKeep = resolve; });
        }
        await keep(result);
        window.__saveFinished = true;
      };
      const { downloadBlob } = await import('/services/pdfShared.ts');
      downloadBlob(new Blob(['result A'], { type: 'application/pdf' }), 'A.pdf');
    });
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => window.__saveStarted);
    await page.evaluate(async () => {
      const { downloadBlob } = await import('/services/pdfShared.ts');
      downloadBlob(new Blob(['result B'], { type: 'application/pdf' }), 'B.pdf');
    });
    await page.getByRole('dialog').getByText(/B.pdf/).waitFor();
    await page.evaluate(() => window.__releaseKeep());
    await page.waitForFunction(() => window.__saveFinished);
    const save = page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true });
    assert.equal(await save.isDisabled(), false, 'finishing Save(A) must leave unsaved B savable');
    assert.equal(await page.getByRole('dialog').getByRole('button', { name: 'Show in Recent', exact: true }).count(), 0);
    assert.deepEqual(await page.evaluate(async () => {
      const { listOutputs } = await import('/services/workspace.ts');
      return (await listOutputs()).map(record => record.filename);
    }), ['A.pdf']);
    await save.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Show in Recent', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(async () => {
      const { listOutputs } = await import('/services/workspace.ts');
      return (await listOutputs()).map(record => record.filename).sort();
    }), ['A.pdf', 'B.pdf']);
    console.log('PASS: Save completion cannot mark a newer result retained; its own Save still works.');
  });

  await withPage('/recent', true, async page => {
    await page.getByText('No files yet', { exact: true }).waitFor();
    await page.evaluate(async () => {
      const { downloadBlob } = await import('/services/pdfShared.ts');
      downloadBlob(new Blob(['late result'], { type: 'application/pdf' }), 'late-result.pdf');
    });
    await page.getByRole('dialog').getByRole('button', { name: 'Show in Recent', exact: true }).click();
    await page.getByText('late-result.pdf', { exact: true }).waitFor();
    assert.equal(await page.getByText('No files yet', { exact: true }).count(), 0);
    console.log('PASS: Recent shows a late result without navigation away or reload.');
  });

  await withPage('/batch', false, async page => {
    const source = await PDFDocument.create();
    for (let index = 0; index < 3; index++) source.addPage().drawText(`Late batch page ${index + 1}`);
    let releaseWorker;
    let workerStarted;
    const started = new Promise(resolve => { workerStarted = resolve; });
    const gate = new Promise(resolve => { releaseWorker = resolve; });
    await page.route(/pdf\.worker/i, async route => {
      if (new URL(route.request().url()).searchParams.has('url')) return route.continue();
      workerStarted();
      await gate;
      return route.continue();
    });
    try {
      await page.getByRole('heading', { name: 'Batch Processing', exact: true }).waitFor();
      await page.locator('input[type=file]').setInputFiles({
        name: 'batch-source.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save()),
      });
      await page.getByRole('button', { name: /Process .*file/ }).click();
      await started;
      await page.getByRole('link', { name: 'Recent', exact: true }).first().click();
      await page.waitForURL('**/recent');
      await page.getByText('No files yet', { exact: true }).waitFor();
      releaseWorker();
      await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Show in Recent', exact: true }).click();
      await page.getByText(/^Batch processing \d{1,2} [A-Z][a-z]{2}\.zip$/).waitFor();
      assert.equal(await page.getByText('No files yet', { exact: true }).count(), 0);
      console.log('PASS: History-off Batch completion followed by explicit Save appears in the already-open Recent list.');
    } finally {
      releaseWorker();
    }
  });

  await withPage('/', false, async page => {
    await installReactHarness(page);
    await page.evaluate(async () => {
      const { WorkspacePlatformProvider, browserPlatform, useRecentRecords } = await import(window.__workspaceModuleUrl);
      let calls = 0;
      const platform = { ...browserPlatform, records: { ...browserPlatform.records, list: async () => {
        calls += 1;
        if (calls === 1) return new Promise(resolve => { window.__releaseFirstRead = resolve; });
        return [{ entry: { name: 'newest.pdf' } }];
      } } };
      const Probe = () => {
        const { state } = useRecentRecords();
        return window.__React.createElement('div', { id: 'recent-read-probe' },
          state.status === 'ready' ? state.value.map(record => record.entry.name).join(',') : state.status);
      };
      const node = document.createElement('div');
      document.body.appendChild(node);
      window.__testRoot = window.__createRoot(node);
      window.__testRoot.render(window.__React.createElement(WorkspacePlatformProvider, { platform }, window.__React.createElement(Probe)));
    });
    await page.waitForFunction(() => window.__releaseFirstRead);
    await page.evaluate(() => window.dispatchEvent(new Event('pdfchef:output-ready')));
    await page.locator('#recent-read-probe').getByText('newest.pdf', { exact: true }).waitFor();
    await page.evaluate(async () => {
      window.__releaseFirstRead([]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.equal(await page.locator('#recent-read-probe').innerText(), 'newest.pdf', 'an old read must not overwrite the output-triggered refresh');
    await page.evaluate(() => window.__testRoot.unmount());
    console.log('PASS: Older Recent reads cannot replace a fresher result list.');
  });

  await withPage('/', false, async page => {
    await installReactHarness(page);
    await page.evaluate(async () => {
      const { MonetizationProvider, useMonetizationContext } = await import('/services/monetization/monetization.tsx');
      const access = { unlocked: false, lifetimeOwned: false, monthlyActive: false, monthlyExpirationDate: null, freeJobsRemaining: 0, freeWindowEndsAt: null };
      window.__exportCalls = 0;
      const bridge = {
        getProducts: async () => ({ products: [] }),
        getAccessState: async () => window.__delayAccess ? new Promise(resolve => { window.__releaseAccess = resolve; }) : access,
        addListener: async () => ({ remove: async () => {} }),
        recordFreeJob: async () => ({ status: 'allowed', access }),
      };
      const Probe = () => { window.__monetization = useMonetizationContext(); return null; };
      const node = document.createElement('div');
      document.body.appendChild(node);
      window.__testRoot = window.__createRoot(node);
      window.__testRoot.render(window.__React.createElement(MonetizationProvider, { bridge, available: true }, window.__React.createElement(Probe)));
    });
    await page.waitForFunction(() => window.__monetization?.loading === false);
    await page.evaluate(() => {
      window.__delayAccess = true;
      window.__pendingRun = window.__monetization.runWithExportAccess(async () => { window.__exportCalls++; }, { operationId: 'discarded-A' });
    });
    await page.waitForFunction(() => window.__releaseAccess);
    const cancelled = await page.evaluate(async () => {
      window.__monetization.cancelPendingExport('discarded-A');
      window.__releaseAccess({ unlocked: false, lifetimeOwned: false, monthlyActive: false, monthlyExpirationDate: null, freeJobsRemaining: 1, freeWindowEndsAt: null });
      return { result: await window.__pendingRun, calls: window.__exportCalls };
    });
    assert.equal(cancelled.calls, 0, 'discarded result must not export after authorization completes');
    assert.equal(cancelled.result.status, 'blocked');
    const active = await page.evaluate(async () => {
      window.__delayAccess = false;
      const result = await window.__monetization.runWithExportAccess(async () => { window.__exportCalls++; }, { operationId: 'active-B' });
      return { result, calls: window.__exportCalls };
    });
    assert.equal(active.result.status, 'completed');
    assert.equal(active.calls, 1, 'an active authorized result must still export normally');
    await page.evaluate(() => window.__testRoot.unmount());
    console.log('PASS: Canceled authorization never exports; an active authorized result does.');
  });
} finally {
  await browser.close();
}
