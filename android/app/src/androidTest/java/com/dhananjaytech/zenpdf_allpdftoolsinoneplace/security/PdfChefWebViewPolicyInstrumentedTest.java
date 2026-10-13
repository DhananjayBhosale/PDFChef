package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.security;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Instrumentation;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebSettings;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.MainActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Runs only on the disposable emulator against the real bridge-bearing MainActivity. */
@RunWith(AndroidJUnit4.class)
public final class PdfChefWebViewPolicyInstrumentedTest {
    @Test public void trustedOriginRunsWhileHostileNavigationRedirectSubresourcesAndPopupsAreRefused()
            throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        Intent intent = new Intent(Intent.ACTION_MAIN)
                .setComponent(new ComponentName(context, MainActivity.class))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(intent);
        instrumentation.waitForIdleSync();

        try {
            AtomicReference<String> currentUrl = new AtomicReference<>();
            long deadline = System.currentTimeMillis() + 15_000L;
            do {
                instrumentation.runOnMainSync(() ->
                        currentUrl.set(activity.getBridge().getWebView().getUrl()));
                if (PdfChefWebViewPolicy.isPackagedOrigin(currentUrl.get())) break;
                Thread.sleep(100L);
            } while (System.currentTimeMillis() < deadline);

            assertTrue("packaged origin did not load: " + currentUrl.get(),
                    PdfChefWebViewPolicy.isPackagedOrigin(currentUrl.get()));

            instrumentation.runOnMainSync(() -> {
                assertTrue(PdfChefWebViewPolicy.isTrustedConfig(activity.getBridge().getConfig()));
                WebView webView = activity.getBridge().getWebView();
                BridgeWebViewClient client = activity.getBridge().getWebViewClient();
                assertTrue(client.getClass().getName().contains("PdfChefWebViewClient"));

                assertFalse(client.shouldOverrideUrlLoading(webView,
                        new Request("https://localhost/tools", true, false)));
                assertTrue(client.shouldOverrideUrlLoading(webView,
                        new Request("intent://hostile/#Intent;scheme=https;end", true, true)));
                assertTrue(client.shouldOverrideUrlLoading(webView,
                        new Request("javascript:alert(1)", true, true)));

                WebResourceResponse blocked = client.shouldInterceptRequest(webView,
                        new Request("https://attacker.example/payload.js", false, false));
                assertNotNull(blocked);
                assertEquals("text/plain", blocked.getMimeType());

                client.onPageStarted(webView, "file:///sdcard/redirect.html", null);
                assertTrue(PdfChefWebViewPolicy.isPackagedOrigin(webView.getUrl()));

                // Popup creation and cross-origin file/content/mixed access remain disabled.
                WebSettings settings = webView.getSettings();
                assertFalse(webView.isSaveEnabled());
                assertFalse(webView.isSaveFromParentEnabled());
                assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, settings.getMixedContentMode());
                assertFalse(settings.getAllowFileAccess());
                assertFalse(settings.getAllowContentAccess());
                assertFalse(settings.getAllowFileAccessFromFileURLs());
                assertFalse(settings.getAllowUniversalAccessFromFileURLs());
                assertFalse(settings.getJavaScriptCanOpenWindowsAutomatically());
                assertFalse(settings.supportMultipleWindows());
            });
        } finally {
            instrumentation.runOnMainSync(activity::finish);
        }
    }

    private static final class Request implements WebResourceRequest {
        private final Uri url;
        private final boolean mainFrame;
        private final boolean redirect;

        Request(String url, boolean mainFrame, boolean redirect) {
            this.url = Uri.parse(url);
            this.mainFrame = mainFrame;
            this.redirect = redirect;
        }

        @Override public Uri getUrl() { return url; }
        @Override public boolean isForMainFrame() { return mainFrame; }
        @Override public boolean isRedirect() { return redirect; }
        @Override public boolean hasGesture() { return false; }
        @Override public String getMethod() { return "GET"; }
        @Override public Map<String, String> getRequestHeaders() { return Collections.emptyMap(); }
    }
}
