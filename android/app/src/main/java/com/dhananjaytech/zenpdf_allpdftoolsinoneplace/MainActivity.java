package com.dhananjaytech.zenpdf_allpdftoolsinoneplace;

import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.AndroidDocumentsPlugin;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.DocumentLifecycleCoordinator;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.IncomingPdfIntake;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.legacy.AndroidLegacyInspectorPlugin;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.legacy.AndroidLegacySettingsWriterPlugin;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.scanner.AndroidDocumentScannerPlugin;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.security.PdfChefWebViewPolicy;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.updates.PlayInAppUpdateController;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.CapConfig;
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicLong;

/** Capacitor host that registers the fixed legacy bridge surface before bridge startup. */
public class MainActivity extends BridgeActivity {
    private static final String EXTRA_RENDERER_RECOVERY_URL =
            "com.dhananjaytech.pdfchef.RENDERER_RECOVERY_URL";
    private static final AtomicLong LAST_RENDERER_RECOVERY_MILLIS = new AtomicLong();
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
    private final ExecutorService intakeExecutor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "pdfchef-incoming-pdf");
        thread.setDaemon(true);
        return thread;
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
        intakeExecutor.shutdownNow();
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
        // Capacitor passes the launch intent to onNewIntent from inside onCreate; it is
        // handled once below instead.
        creating = true;
        try {
            super.onCreate(savedInstanceState);
        } finally {
            creating = false;
        }
        // Reopening from Recents after the process ended gives back the task's first intent,
        // either as a restored screen (saved state) or as a relaunch from history. That PDF
        // was taken in already; showing it again would be a surprise.
        if (savedInstanceState == null
                && !IncomingPdfIntake.isReplayedFromRecents(getIntent().getFlags())) {
            acceptIncomingPdf(getIntent());
        }
        inAppUpdateController = PlayInAppUpdateController.create(this, inAppUpdateLauncher);
        inAppUpdateController.checkForUpdate();
    }

    @Override
    public void onResume() {
        super.onResume();
        if (inAppUpdateController != null) inAppUpdateController.checkForUpdate();
    }

    /**
     * A PDF arriving from another app.
     *
     * `singleTask` means a second hand-over reaches the running Activity here
     * rather than through onCreate, so both entry points feed the same intake.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (!creating) acceptIncomingPdf(intent);
    }

    /**
     * Copy the handed-over document into owned storage, then tell the page it is
     * waiting. The bytes are read off the main thread; a hand-over this app will
     * not accept simply leaves the app as it was rather than interrupting.
     */
    private void acceptIncomingPdf(Intent intent) {
        if (!IncomingPdfIntake.isIncomingPdf(intent)) return;
        // Consume it: a configuration change must not import the same file twice.
        setIntent(new Intent(Intent.ACTION_MAIN));
        final Intent handedOver = intent;
        try {
            intakeExecutor.execute(() -> {
                String documentRef;
                try {
                    DocumentLifecycleCoordinator coordinator =
                            ((PdfChefApplication) getApplicationContext())
                                    .getDocumentLifecycleCoordinator();
                    String sourceName = IncomingPdfIntake.sourceDisplayName(
                            getContentResolver(), handedOver);
                    documentRef = new IncomingPdfIntake().accept(
                            coordinator, handedOver, sourceName);
                } catch (Exception failure) {
                    return;
                }
                if (documentRef == null) return;
                runOnUiThread(() -> announceIncoming(documentRef));
            });
        } catch (RejectedExecutionException ignored) {
            // The Activity is going away; the document was never copied in.
        }
    }

    private void announceIncoming(String documentRef) {
        try {
            PluginHandle handle = getBridge() == null ? null : getBridge().getPlugin("AndroidDocuments");
            Object plugin = handle == null ? null : handle.getInstance();
            if (plugin instanceof AndroidDocumentsPlugin documents) {
                documents.announceIncomingPdf(documentRef);
            }
        } catch (Exception ignored) {
            // Without the bridge the copy still exists; the page collects it on its next look.
        }
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
        String recoveryUrl = getIntent().getStringExtra(EXTRA_RENDERER_RECOVERY_URL);
        getIntent().removeExtra(EXTRA_RENDERER_RECOVERY_URL);
        if (PdfChefWebViewPolicy.isPackagedOrigin(recoveryUrl)) webView.loadUrl(recoveryUrl);
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
            if (PdfChefWebViewPolicy.isPackagedOrigin(recoveryUrl)) {
                getIntent().putExtra(EXTRA_RENDERER_RECOVERY_URL, recoveryUrl);
            }
            ViewParent parent = view.getParent();
            if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(view);
            view.destroy();

            long now = SystemClock.elapsedRealtime();
            if (claimRendererRecovery(now)) {
                getWindow().getDecorView().post(() -> {
                    if (!isFinishing() && !isDestroyed()) recreate();
                });
            } else {
                finish();
            }
            return true;
        }
    }

    private static WebResourceResponse blockedResponse() {
        return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
    }
}
