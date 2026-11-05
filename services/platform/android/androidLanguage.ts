import { registerPlugin } from '@capacitor/core';
import { subscribeNativeLanguage } from '../../i18n/core.ts';

export interface AndroidLanguageNativePlugin {
  setLanguage(options: { language: string }): Promise<unknown>;
}

const AndroidLanguageNative = registerPlugin<AndroidLanguageNativePlugin>('AndroidLanguage');

/**
 * Keeps Android's native screens (the PDF reader, the update dialog) in the language the app shows.
 * A language chosen in Settings is sent as is. On System, "system" is sent instead of today's
 * resolved language, so the native screens follow the phone through Android's own resource
 * matching and stay right after the phone's language changes, even before this layer runs again.
 * Returns the unsubscribe.
 */
export const syncAndroidLanguage = (native: AndroidLanguageNativePlugin = AndroidLanguageNative): (() => void) =>
  // A missing or older native shell keeps the phone's language; nothing else depends on this.
  subscribeNativeLanguage(language => { native.setLanguage({ language }).catch(() => undefined); });
