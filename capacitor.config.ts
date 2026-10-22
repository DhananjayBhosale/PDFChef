import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.dhananjaytech.pdfchef',
  appName: 'PDF Chef',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
    // PDF.js calls Promise.withResolvers (WebView 119) with no fallback. Older WebViews get
    // public/webview-update/ instead of the app; see MainActivity.configureWebViewBoundary.
    minWebViewVersion: 119,
  },
  cordova: {
    accessOrigins: [],
  },
};

export default config;
