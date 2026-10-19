package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.security;

import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.CapConfig;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * The WebView's trust boundary. Only the packaged Capacitor origin may execute in the
 * bridge-bearing WebView; user-facing web links are handed to the system browser instead.
 */
public final class PdfChefWebViewPolicy {
    public static final String PACKAGED_ORIGIN = "https://localhost";
    public static final long RENDERER_RECOVERY_COOLDOWN_MILLIS = 30_000L;

    public enum Navigation {
        ALLOW_PACKAGED_ORIGIN,
        OPEN_EXTERNAL_BROWSER,
        BLOCK
    }

    private PdfChefWebViewPolicy() {}

    /** Pure decision used for main-frame navigations and subresource checks. */
    public static Navigation decide(String rawUrl) {
        if (rawUrl == null || rawUrl.isEmpty()) return Navigation.BLOCK;
        try {
            URI uri = new URI(rawUrl);
            if (isPackagedOrigin(uri)) return Navigation.ALLOW_PACKAGED_ORIGIN;
            if (looksLikePackagedHost(uri)) return Navigation.BLOCK;
            if (isSafeExternalLink(uri)) return Navigation.OPEN_EXTERNAL_BROWSER;
        } catch (URISyntaxException ignored) {
            // Malformed values cannot participate in a bridge navigation.
        }
        return Navigation.BLOCK;
    }

    public static boolean isPackagedOrigin(String rawUrl) {
        try {
            return rawUrl != null && isPackagedOrigin(new URI(rawUrl));
        } catch (URISyntaxException ignored) {
            return false;
        }
    }

    /** Rejects any runtime config that could move the bridge away from the packaged origin. */
    public static boolean isTrustedConfig(CapConfig config) {
        if (config == null || config.getServerUrl() != null) return false;
        if (!"https".equals(lower(config.getAndroidScheme()))) return false;
        if (!"localhost".equals(lower(config.getHostname()))) return false;
        String[] allowNavigation = config.getAllowNavigation();
        return allowNavigation == null || allowNavigation.length == 0;
    }

    /**
     * One production crash is inside the mt6855 GLES driver while Chromium draws the app. Keep
     * hardware acceleration everywhere else; only that exact driver family uses WebView's software
     * layer until its vendor implementation is fixed.
     */
    public static boolean requiresSoftwareRendering(String hardware, String socModel) {
        return "mt6855".equals(lower(hardware)) || "mt6855".equals(lower(socModel));
    }

    /** Fragment added to a route reloaded after the renderer died, so the page can say so once. */
    public static final String RENDERER_RECOVERY_FRAGMENT = "renderer-restarted";

    /** The same packaged route carrying the recovery fragment, or null for any other URL. */
    public static String rendererRecoveryUrl(String rawUrl) {
        if (!isPackagedOrigin(rawUrl)) return null;
        int fragment = rawUrl.indexOf('#');
        String route = fragment >= 0 ? rawUrl.substring(0, fragment) : rawUrl;
        return route + "#" + RENDERER_RECOVERY_FRAGMENT;
    }

    /** Prevents a repeatedly crashing WebView renderer from causing a restart loop. */
    public static boolean mayRestartRenderer(long previousElapsedMillis, long nowElapsedMillis) {
        return nowElapsedMillis >= 0 && (previousElapsedMillis <= 0
                || nowElapsedMillis - previousElapsedMillis >= RENDERER_RECOVERY_COOLDOWN_MILLIS);
    }

    /** Applies the WebView defense-in-depth settings before and after Bridge construction. */
    @SuppressWarnings("deprecation")
    public static void apply(WebView webView) {
        // Persistent documents/history live in the workspace, not an Activity's Binder Bundle.
        // Keep Capacitor's plugin/result state; omit only the transient WebView hierarchy.
        webView.setSaveEnabled(false);
        webView.setSaveFromParentEnabled(false);
        WebSettings settings = webView.getSettings();
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        WebView.setWebContentsDebuggingEnabled(false);
    }

    private static boolean isPackagedOrigin(URI uri) {
        if (!"https".equals(lower(uri.getScheme()))) return false;
        if (!"localhost".equals(lower(uri.getHost()))) return false;
        if (uri.getPort() != -1 && uri.getPort() != 443) return false;
        return uri.getRawUserInfo() == null;
    }

    private static boolean isSafeExternalLink(URI uri) {
        String scheme = lower(uri.getScheme());
        if ("https".equals(scheme) || "http".equals(scheme)) {
            return uri.getRawUserInfo() == null && uri.getHost() != null;
        }
        if ("mailto".equals(scheme)) {
            String recipient = uri.getRawSchemeSpecificPart();
            return recipient != null && !recipient.isEmpty()
                    && recipient.indexOf('\r') < 0 && recipient.indexOf('\n') < 0
                    && !lower(recipient).contains("%0d") && !lower(recipient).contains("%0a");
        }
        return false;
    }

    private static boolean looksLikePackagedHost(URI uri) {
        String host = lower(uri.getHost());
        return "localhost".equals(host) || host.startsWith("localhost.") || host.endsWith(".localhost");
    }

    private static String lower(String value) {
        return value == null ? "" : value.toLowerCase(Locale.ROOT);
    }
}
