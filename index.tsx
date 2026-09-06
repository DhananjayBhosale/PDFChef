import { installReadableStreamAsyncIteration } from './services/readableStreamAsyncIteration';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { AppRoot, type AppRootProps } from './App';
import {
  createIOSWorkspacePlatform,
  isPdfChefDocumentsAvailable,
} from './services/platform/capacitor/iosDocumentServices';
import { startAndroidOnboardingContinuity } from './services/platform/android/androidOnboardingContinuity';
import { createAndroidWorkspacePlatform } from './services/platform/android/androidWorkspacePlatform';
import { browserPlatform } from './hooks/useWorkspaceRuntime';
import '@fontsource-variable/inter';
import '@fontsource-variable/manrope';
import '@fontsource/cormorant-garamond/600.css';
import '@fontsource/cormorant-garamond/700.css';
import '@fontsource/noto-sans/400.css';
import '@fontsource/noto-sans/700.css';
import './assets/design-tokens.css';
import './index.css';

// Before anything can reach for PDF.js: on iOS its text extraction depends on a stream feature
// that engine does not have, and without this the editor finds no paragraphs in any document.
installReadableStreamAsyncIteration();

// #region packaged-shell-boundary
/* Deliberately plain JavaScript with every dependency passed in: the security tests
   execute these exact bytes in an isolated context, so the packaged-shell boundary is
   proven rather than restated. Nothing in this region may import, use JSX, read a
   module-scope global, or register a service worker. */

/** The two origins only a packaged native shell is ever served from. */
const PACKAGED_NATIVE_ORIGINS = ['https://localhost', 'capacitor://localhost'];
const SHELL_CACHE_PREFIX = 'pdf-chef-shell-';
const SHELL_WORKER_PATH = '/sw.js';
const SHELL_CLEANUP_BUDGET_MS = 4000;

/**
 * Browser is the only positively identified target. An iOS or Android bridge names
 * itself, a packaged origin without a bridge is still native, and anything else stays
 * `native` so service-worker registration fails closed instead of guessing.
 */
const resolveShellTarget = (platform, origin) => {
  if (platform === 'ios') return 'ios';
  if (platform === 'android') return 'android';
  if (platform === 'web' && PACKAGED_NATIVE_ORIGINS.indexOf(origin) === -1) return 'browser';
  return 'native';
};

/**
 * Cleanup is destructive, so it runs only where the shell is positively native. An
 * unreadable platform on a public origin registers nothing and deletes nothing.
 */
const isPackagedNativeShell = (target, origin) => target === 'ios'
  || target === 'android'
  || (target === 'native' && PACKAGED_NATIVE_ORIGINS.indexOf(origin) !== -1);

/** Runs `run` but always settles: a rejection or a promise that never settles resolves to `fallback`. */
const settleWithin = (run, fallback, budgetMs) => new Promise((resolve) => {
  let settled = false;
  let timer = null;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    resolve(value);
  };
  timer = setTimeout(() => finish(fallback), budgetMs);
  try {
    Promise.resolve(run()).then((value) => finish(value), () => finish(fallback));
  } catch {
    finish(fallback);
  }
});

/** `URL.origin` is `null` for the iOS `capacitor:` scheme, so the origin is rebuilt from its parts. */
const originOf = (url) => `${url.protocol}//${url.host}`;

/** True only for this origin's own app-shell worker, never for another site's or another path's. */
const isShellRegistration = (registration, origin) => {
  if (!registration) return false;
  const worker = registration.active || registration.waiting || registration.installing;
  const scriptURL = worker ? worker.scriptURL : null;
  try {
    if (typeof scriptURL === 'string' && scriptURL !== '') {
      const script = new URL(scriptURL, origin);
      return originOf(script) === origin && script.pathname === SHELL_WORKER_PATH;
    }
    // A registration whose worker record is gone can only be identified by its scope.
    const scope = new URL(registration.scope, origin);
    return originOf(scope) === origin && scope.pathname === '/';
  } catch {
    return false;
  }
};

const releaseShellServiceWorkers = (container, origin, budgetMs) => {
  if (!container || typeof container.getRegistrations !== 'function') return Promise.resolve(undefined);
  return settleWithin(() => container.getRegistrations(), [], budgetMs)
    .then((registrations) => Promise.all((Array.isArray(registrations) ? registrations : [])
      .filter((registration) => isShellRegistration(registration, origin))
      .map((registration) => settleWithin(() => registration.unregister(), false, budgetMs))))
    .then(() => undefined);
};

/** Deletes this product's own shell caches only. Any other cache in the browser is left alone. */
const releaseShellCaches = (cacheStorage, budgetMs) => {
  if (!cacheStorage || typeof cacheStorage.keys !== 'function') return Promise.resolve(undefined);
  return settleWithin(() => cacheStorage.keys(), [], budgetMs)
    .then((names) => Promise.all((Array.isArray(names) ? names : [])
      .filter((name) => typeof name === 'string' && name.indexOf(SHELL_CACHE_PREFIX) === 0)
      .map((name) => settleWithin(() => cacheStorage.delete(name), false, budgetMs))))
    .then(() => undefined);
};

/** Always settles and never rejects, so no caller can be made to wait on a cleanup API. */
const releasePackagedNativeShellState = (scope, budgetMs) => settleWithin(() => {
  const container = scope && scope.navigator ? scope.navigator.serviceWorker : null;
  const cacheStorage = scope ? scope.caches : null;
  const origin = scope && scope.location ? originOf(scope.location) : '';
  return Promise.all([
    releaseShellServiceWorkers(container, origin, budgetMs),
    releaseShellCaches(cacheStorage, budgetMs),
  ]);
}, null, budgetMs).then(() => undefined);
// #endregion packaged-shell-boundary

/** The bridge is a plain global read, but an unreadable platform must not read as browser. */
const readCapacitorPlatform = (): string | null => {
  try {
    return Capacitor.getPlatform();
  } catch {
    return null;
  }
};

// Built from the location's parts rather than read from `location.origin`, which some
// engines serialise as "null" for the iOS custom scheme.
const shellOrigin = originOf(window.location);
const shellTarget = resolveShellTarget(readCapacitorPlatform(), shellOrigin);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element");
}

const root = ReactDOM.createRoot(rootElement);

const render = (platform?: AppRootProps['platform']) => {
  root.render(
    <React.StrictMode>
      <AppRoot platform={platform} />
    </React.StrictMode>
  );
};

/**
 * Discovery runs only where an iOS adapter could exist, and never decides
 * whether the app starts. The helper reads a native header that may not be
 * there, so a throw means "no adapter", not "no interface".
 */
const iosDocumentsAvailable = (): boolean => {
  if (shellTarget !== 'ios') return false;
  try {
    return isPdfChefDocumentsAvailable();
  } catch {
    return false;
  }
};

if (iosDocumentsAvailable()) {
  // Native iOS with the real plugin header present. One platform is created here
  // and the same instance is what the interface receives, so the pending-import
  // listener, the retained store and the UI never disagree about which adapter
  // they are talking to. Creating it outside React keeps StrictMode's double
  // invocation from producing a second one.
  const platform = createIOSWorkspacePlatform();
  void platform.ready
    .catch(() => {
      // Listener registration failed. The adapter itself is still the one the
      // interface must use, so it is injected either way and the failure is
      // reported as a bare fact: no exception, document, name or address reaches
      // the console.
      console.warn('Pending document delivery could not start.');
    })
    .then(() => render(platform));
} else if (shellTarget === 'android') {
  // Native Android. The adapter is built once here, outside StrictMode, so the
  // single documents client, the durable record list and the optional scanner
  // and reader ports are the same instance the interface talks to for the whole
  // session. An install-over update may already carry completed onboarding, so
  // first render waits for one bounded strict legacy read. Timeout, failure or
  // absence keeps the normal first-run sheet and refuses a late native write.
  const androidPlatform = createAndroidWorkspacePlatform(browserPlatform);
  void startAndroidOnboardingContinuity(settleWithin, () => render(androidPlatform));
} else {
  // Browser and installed PWA: no native adapter, so the interface runs on its
  // own fallback and reports the capabilities it does not have.
  render();
}

if (isPackagedNativeShell(shellTarget, shellOrigin)) {
  // A packaged shell must never be controlled by the browser app shell: its assets
  // come from the verified package, so a same-origin service worker could only serve
  // stale or substituted content. Registration is skipped and any registration or
  // shell cache left by an earlier build is released as defence in depth. This is
  // deliberately not chained to render: it always settles, and rendering never waits
  // on it either way.
  void releasePackagedNativeShellState(window, SHELL_CLEANUP_BUDGET_MS);
} else if (shellTarget === 'browser' && 'serviceWorker' in navigator && import.meta.env.PROD) {
  // Keep first paint and early interaction ahead of the full offline-shell install.
  // The worker still preserves the same complete-offline contract once registered.
  const registerOfflineShell = () => {
    void navigator.serviceWorker.register(SHELL_WORKER_PATH).catch(() => {
      console.warn('Offline app shell could not be registered.');
    });
  };
  window.addEventListener('load', () => {
    const requestIdle = Reflect.get(window, 'requestIdleCallback');
    if (typeof requestIdle === 'function') {
      requestIdle.call(window, registerOfflineShell, { timeout: 3000 });
    } else {
      window.setTimeout(registerOfflineShell, 1500);
    }
  }, { once: true });
}
