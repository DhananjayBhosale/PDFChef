import { useEffect, useRef } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Android back follows the interface before it leaves the Activity:
 * dismiss the top sheet, pop React history, return a direct tool launch Home,
 * and exit only when Home is already the first history entry.
 */
export const NativeBackHandler = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const pathname = useRef(location.pathname);

  useEffect(() => {
    pathname.current = location.pathname;
  }, [location.pathname]);

  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return undefined;

    const registration = CapacitorApp.addListener('backButton', () => {
      const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      document.dispatchEvent(escape);
      if (escape.defaultPrevented) return;

      const index = Reflect.get(window.history.state ?? {}, 'idx');
      if (Number.isSafeInteger(index) && index > 0) {
        navigate(-1);
        return;
      }
      if (pathname.current !== '/') {
        navigate('/', { replace: true });
        return;
      }
      void CapacitorApp.exitApp();
    });

    return () => {
      void registration.then((handle) => handle.remove()).catch(() => undefined);
    };
  }, [navigate]);

  return null;
};
