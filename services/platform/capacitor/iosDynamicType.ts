/** WebKit's body text is 17px at iOS's default text size. Past double, rem layouts stop fitting a phone. */
export const dynamicTypeScale = (bodyPixels: number): number =>
  Number.isFinite(bodyPixels) && bodyPixels > 0 ? Math.round(Math.min(2, bodyPixels / 17) * 100) / 100 : 1;

/**
 * Lets the phone's text size (Dynamic Type) scale the app's text, on top of the in-app Text size.
 * WebKit sizes `-apple-system-body` from Dynamic Type, so a hidden probe in that font reports
 * the size without native code.
 * Returns the cleanup.
 */
export const followDynamicType = (root: HTMLElement = document.documentElement): (() => void) => {
  if (typeof ResizeObserver === 'undefined' || !CSS.supports('font', '-apple-system-body')) return () => undefined;
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.textContent = 'A';
  probe.style.cssText = 'position:fixed;top:0;left:-9999px;visibility:hidden;pointer-events:none;font:-apple-system-body';
  document.body.append(probe);
  const update = () => {
    const scale = dynamicTypeScale(parseFloat(getComputedStyle(probe).fontSize));
    root.style.setProperty('--system-text-scale', String(scale));
    root.dataset.systemTextScale = scale >= 1.1 ? 'large' : 'default';
  };
  update();
  // The text size changes in iOS Settings or Control Center, so check again whenever the app returns.
  const observer = new ResizeObserver(update);
  observer.observe(probe);
  document.addEventListener('visibilitychange', update);
  return () => {
    document.removeEventListener('visibilitychange', update);
    observer.disconnect();
    probe.remove();
    root.style.removeProperty('--system-text-scale');
    delete root.dataset.systemTextScale;
  };
};
