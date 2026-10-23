/**
 * The fragment the Android and iOS shells append when they reload the current route
 * after the web page's renderer died. Mirrored in PdfChefWebViewPolicy.java and
 * PdfChefBridgeViewController.swift.
 */
export const RENDERER_RECOVERY_HASH = '#renderer-restarted';

export const wasRendererRestarted = (hash: string): boolean => hash === RENDERER_RECOVERY_HASH;
