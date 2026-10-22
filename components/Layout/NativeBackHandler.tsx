import { useEffect, useRef } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useLocation, useNavigate } from 'react-router-dom';
import { historyIndex, openedByTab, returnToTools } from './navigationHistory';

/**
 * Android back follows the interface before it leaves the Activity: dismiss the
 * top sheet first, and leave the app from Tools, as other apps with a tab bar do.
 * Recent or Settings opened from the tab bar goes back to Tools. Any other screen
 * pops React history, and one with nothing behind it returns to Tools.
 */
export const NativeBackHandler = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const here = useRef({ path: location.pathname, tab: openedByTab(location.state) });

  useEffect(() => {
    here.current = { path: location.pathname, tab: openedByTab(location.state) };
  }, [location.pathname, location.state]);

  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return undefined;

    const registration = CapacitorApp.addListener('backButton', () => {
      const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      document.dispatchEvent(escape);
      if (escape.defaultPrevented) return;

      const { path, tab } = here.current;
      if (path === '/') {
        void CapacitorApp.exitApp();
        return;
      }
      if (tab) {
        returnToTools(navigate);
        return;
      }
      if (historyIndex() > 0) {
        navigate(-1);
        return;
      }
      navigate('/', { replace: true });
    });

    return () => {
      void registration.then((handle) => handle.remove()).catch(() => undefined);
    };
  }, [navigate]);

  return null;
};
