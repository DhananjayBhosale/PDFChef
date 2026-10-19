/**
 * The fragment the Android shell appends when it reloads the current route after
 * the WebView renderer died. Mirrored in PdfChefWebViewPolicy.java.
 */
export const RENDERER_RECOVERY_HASH = '#renderer-restarted';

export const wasRendererRestarted = (hash: string): boolean => hash === RENDERER_RECOVERY_HASH;
