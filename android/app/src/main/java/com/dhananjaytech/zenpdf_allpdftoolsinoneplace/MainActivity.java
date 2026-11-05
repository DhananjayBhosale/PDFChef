package com.dhananjaytech.zenpdf_allpdftoolsinoneplace;

import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.AndroidDocumentsPlugin;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.legacy.AndroidLegacyInspectorPlugin;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.legacy.AndroidLegacySettingsWriterPlugin;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.scanner.AndroidDocumentScannerPlugin;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.security.PdfChefWebViewPolicy;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.updates.PlayInAppUpdateController;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.CapConfig;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.PluginHandle;
import java.io.ByteArrayInputStream;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

/** Capacitor host that registers the fixed legacy bridge surface before bridge startup. */
public class MainActivity extends BridgeActivity {
    /** The route a renderer death interrupted; kept in the process so no other app can set it. */
    private static final AtomicReference<String> PENDING_RENDERER_RECOVERY_URL = new AtomicReference<>();
    private static final AtomicLong LAST_RENDERER_RECOVERY_MILLIS = new AtomicLong();
    /** What a PDF opened from another app still needs from the page; kept in the process so no other app can set it. */
    private static final AtomicReference<Consumer<AndroidDocumentsPlugin>> PENDING_HANDOVER = new AtomicReference<>();
    private android.view.ViewTreeObserver.OnPreDrawListener systemBarBackgroundListener;
    private Boolean lightSystemBars;
    private boolean rendererGone;
    private boolean creating;
    private PlayInAppUpdateController inAppUpdateController;
    private final ActivityResultLauncher<IntentSenderRequest> inAppUpdateLauncher =
            registerForActivityResult(
                    new ActivityResultContracts.StartIntentSenderForResult(),
                    result -> {
                        if (inAppUpdateController != null) {
                            inAppUpdateController.onUpdateFlowResult(result.getResultCode());
                        }
                    });

    @Override
    public void onStart() {
        super.onStart();
        WebView webView = bridgeWebView();
        if (webView != null) webView.onResume();
    }

    @Override
    public void onStop() {
        WebView webView = bridgeWebView();
        if (webView != null) webView.onPause();
        super.onStop();
    }

    @Override
    public void onDestroy() {
        if (inAppUpdateController != null) inAppUpdateController.close();
        if (systemBarBackgroundListener != null) {
            getWindow().getDecorView().getViewTreeObserver().removeOnPreDrawListener(systemBarBackgroundListener);
        }
        super.onDestroy();
    }

    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(AndroidLegacyInspectorPlugin.class);
        registerPlugin(AndroidLegacySettingsWriterPlugin.class);
        registerPlugin(AndroidAppMetadataPlugin.class);
        registerPlugin(AndroidStorageStatsPlugin.class);
        registerPlugin(AndroidDocumentsPlugin.class);
        registerPlugin(AndroidDocumentScannerPlugin.class);
        registerPlugin(AndroidSupportPlugin.class);
        registerPlugin(AndroidLanguagePlugin.class);
        // Capacitor passes the launch intent to onNewIntent from inside onCreate; a hand-over
        // is delivered once below instead, after the bridge exists.
        creating = true;
        try {
            super.onCreate(savedInstanceState);
        } finally {
            creating = false;
        }
        deliverHandOver();
        inAppUpdateController = PlayInAppUpdateController.create(this, inAppUpdateLauncher);
        inAppUpdateController.checkForUpdate();
    }

    @Override
    public void onResume() {
        super.onResume();
        // First resume of a process: no capture can be in flight yet.
        CapturedPhotoSweep.sweepOncePerProcess(this);
        if (inAppUpdateController != null) inAppUpdateController.checkForUpdate();
    }

    /**
     * Brings the app forward to finish what a PDF opened from another app needs from the page:
     * a tool chosen in the reader, or a refused file to explain. Only {@link IncomingPdfActivity}
     * calls this, in this process, so no other app can choose the document or the tool.
     */
    static void handOver(Activity from, Consumer<AndroidDocumentsPlugin> announcement) {
        PENDING_HANDOVER.set(announcement);
        from.startActivity(new Intent(from, MainActivity.class));
    }

    /** `singleTask` means a hand-over to the running app arrives here rather than through onCreate. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (!creating) deliverHandOver();
    }

    /** The plugin keeps the event until the page listens, so a cold start loses nothing. */
    private void deliverHandOver() {
        Consumer<AndroidDocumentsPlugin> announcement = PENDING_HANDOVER.getAndSet(null);
        if (announcement == null) return;
        try {
            AndroidDocumentsPlugin documents = documentsPlugin();
            if (documents != null) announcement.accept(documents);
        } catch (Exception ignored) {
            // Without the bridge the copy still exists and is listed in Recent.
        }
    }

    private AndroidDocumentsPlugin documentsPlugin() {
        PluginHandle handle = getBridge() == null ? null : getBridge().getPlugin("AndroidDocuments");
        Object plugin = handle == null ? null : handle.getInstance();
        return plugin instanceof AndroidDocumentsPlugin documents ? documents : null;
    }

    @Override
    protected void load() {
        WebView webView = findViewById(com.getcapacitor.android.R.id.webview);
        config = CapConfig.loadDefault(this);
        if (webView == null || !PdfChefWebViewPolicy.isTrustedConfig(config)) {
            if (webView != null) webView.stopLoading();
            return;
        }

        // This runs before Bridge construction, where Capacitor registers plugins and calls loadUrl().
        PdfChefWebViewPolicy.apply(webView);
        configureGraphicsLayer(webView);
        super.load();
        configureWebViewBoundary(getBridge());
    }

    private void configureWebViewBoundary(Bridge bridge) {
        WebView webView = bridge.getWebView();
        if (!PdfChefWebViewPolicy.isTrustedConfig(bridge.getConfig())
                || !PdfChefWebViewPolicy.isPackagedOrigin(bridge.getAppUrl())) {
            webView.stopLoading();
            return;
        }
        PdfChefWebViewPolicy.apply(webView);
        configureGraphicsLayer(webView);
        bridge.setWebViewClient(new PdfChefWebViewClient(bridge));
        String recoveryUrl = PENDING_RENDERER_RECOVERY_URL.getAndSet(null);
        // The same screen comes back, and the page is told so it can say what happened. An older
        // WebView lacks what PDF.js calls without a fallback, so it gets a page that says to update it.
        String reload = bridge.isMinimumWebViewInstalled()
                ? PdfChefWebViewPolicy.rendererRecoveryUrl(recoveryUrl)
                : PdfChefWebViewPolicy.WEBVIEW_UPDATE_URL;
        if (reload != null) webView.loadUrl(reload);
        synchronizeSystemBarBackground();
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                if (PdfChefWebViewPolicy.isPackagedOrigin(request.getUrl().toString())) {
                    WebResourceResponse response = bridge.getLocalServer().shouldInterceptRequest(request);
                    if (response != null) return response;
                }
                return blockedResponse();
            }
        });
    }

    private WebView bridgeWebView() {
        if (rendererGone) return null;
        Bridge current = getBridge();
        return current == null ? null : current.getWebView();
    }

    private static void configureGraphicsLayer(WebView webView) {
        String socModel = Build.VERSION.SDK_INT >= 31 ? Build.SOC_MODEL : "";
        if (PdfChefWebViewPolicy.requiresSoftwareRendering(Build.HARDWARE, socModel)) {
            webView.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        }
    }

    private static boolean claimRendererRecovery(long now) {
        while (true) {
            long previous = LAST_RENDERER_RECOVERY_MILLIS.get();
            if (!PdfChefWebViewPolicy.mayRestartRenderer(previous, now)) return false;
            if (LAST_RENDERER_RECOVERY_MILLIS.compareAndSet(previous, now)) return true;
        }
    }

    private void synchronizeSystemBarBackground() {
        android.view.View decor = getWindow().getDecorView();
        if (systemBarBackgroundListener != null) return;
        systemBarBackgroundListener = () -> {
            var controller = androidx.core.view.WindowCompat.getInsetsController(getWindow(), decor);
            // StatusBar.setStyle already receives the resolved web theme. Use
            // that native appearance signal instead of the OS theme, which can
            // differ from the app's explicit light/dark preference.
            boolean light = controller.isAppearanceLightStatusBars();
            if (lightSystemBars == null || lightSystemBars != light) {
                lightSystemBars = light;
                int color = android.graphics.Color.parseColor(light ? "#f8f5ef" : "#16140f");
                findViewById(android.R.id.content).setBackgroundColor(color);
                controller.setAppearanceLightNavigationBars(light);
                if (android.os.Build.VERSION.SDK_INT < 35) {
                    getWindow().setStatusBarColor(color);
                    getWindow().setNavigationBarColor(color);
                }
            }
            return true;
        };
        // Android 15+ draws the inset strip behind transparent system bars.
        // Update its host background when the icon appearance changes.
        decor.getViewTreeObserver().addOnPreDrawListener(systemBarBackgroundListener);
    }

    private final class PdfChefWebViewClient extends BridgeWebViewClient {
        PdfChefWebViewClient(Bridge bridge) {
            super(bridge);
        }

        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            PdfChefWebViewPolicy.Navigation decision = PdfChefWebViewPolicy.decide(request.getUrl().toString());
            if (decision == PdfChefWebViewPolicy.Navigation.ALLOW_PACKAGED_ORIGIN) return false;
            if (request.isForMainFrame()
                    && decision == PdfChefWebViewPolicy.Navigation.OPEN_EXTERNAL_BROWSER) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                } catch (ActivityNotFoundException ignored) {
                    // The navigation remains outside the bridge when no browser can handle it.
                }
            }
            return true;
        }

        @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (!PdfChefWebViewPolicy.isPackagedOrigin(url)) {
                view.stopLoading();
                return;
            }
            super.onPageStarted(view, url, favicon);
        }

        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (PdfChefWebViewPolicy.isPackagedOrigin(request.getUrl().toString())) {
                return super.shouldInterceptRequest(view, request);
            }
            return blockedResponse();
        }

        @Override public boolean onRenderProcessGone(
                WebView view, RenderProcessGoneDetail detail) {
            // Android terminates the host when any associated WebView leaves this callback
            // unhandled. The dead instance cannot be reused: detach and destroy it, then rebuild
            // the Capacitor bridge once. A second failure inside the cooldown closes cleanly
            // instead of entering a restart loop.
            rendererGone = true;
            String recoveryUrl = view.getUrl();
            ViewParent parent = view.getParent();
            if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(view);
            view.destroy();

            long now = SystemClock.elapsedRealtime();
            if (claimRendererRecovery(now)) {
                getWindow().getDecorView().post(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    // Stored only for the rebuild that reads it, so a later launch never reopens it.
                    if (PdfChefWebViewPolicy.isPackagedOrigin(recoveryUrl)) {
                        PENDING_RENDERER_RECOVERY_URL.set(recoveryUrl);
                    }
                    recreate();
                });
            } else {
                PENDING_RENDERER_RECOVERY_URL.set(null);
                finish();
            }
            return true;
        }
    }

    private static WebResourceResponse blockedResponse() {
        return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
    }
}
