package com.dhananjaytech.zenpdf_allpdftoolsinoneplace;

import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.DocumentLifecycleCoordinator;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.IncomingPdfIntake;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader.PdfReaderLaunchContract;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/**
 * Where "Open with" and "Share" land. The PDF is copied in and shown straight in the reader,
 * inside the sending app's task: the Tools screen never appears first, closing the reader goes
 * back to that app, and every hand-over is a fresh launch. Only a tool chosen in the reader, or
 * a file this app refuses, brings the main app forward.
 *
 * This window is transparent, so the reader appears over the sending app with nothing between.
 */
public final class IncomingPdfActivity extends ComponentActivity {
    private static final String STATE_REF = "pdfchef.incoming.ref";
    private static final long SPINNER_DELAY_MILLIS = 400;

    private final ActivityResultLauncher<Intent> reader = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(), this::readerFinished);
    private final ExecutorService intake = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "pdfchef-incoming-pdf");
        thread.setDaemon(true);
        return thread;
    });
    /** The owned copy shown in the reader; set once the reader is launched. */
    private String ref;
    private ProgressBar spinner;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (savedInstanceState != null) {
            // The reader above is being restored and still answers here. Without a reader the
            // copy was cut short when Android ended the process, so there is nothing to wait for.
            ref = savedInstanceState.getString(STATE_REF);
            if (ref == null) finish();
            return;
        }
        Intent intent = getIntent();
        // Reopening from Recents after the process ended replays the first intent; that PDF
        // was already taken in.
        if (!IncomingPdfIntake.isIncomingPdf(intent)
                || IncomingPdfIntake.isReplayedFromRecents(intent.getFlags())) {
            finish();
            return;
        }
        showDelayedSpinner();
        try {
            intake.execute(() -> copyIn(intent));
        } catch (RejectedExecutionException ignored) {
            finish();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putString(STATE_REF, ref);
    }

    @Override
    protected void onDestroy() {
        // A copy still running is cancelled; nothing half-written is kept.
        intake.shutdownNow();
        super.onDestroy();
    }

    /** Off the main thread: the bytes are read here. */
    private void copyIn(Intent handedOver) {
        DocumentLifecycleCoordinator coordinator =
                ((PdfChefApplication) getApplicationContext()).getDocumentLifecycleCoordinator();
        try {
            String sourceName = IncomingPdfIntake.sourceDisplayName(getContentResolver(), handedOver);
            String copied = new IncomingPdfIntake().accept(coordinator, handedOver, sourceName);
            String displayName = copied == null ? null : displayNameOf(coordinator, copied);
            if (displayName == null) {
                runOnUiThread(() -> refuse(IncomingPdfIntake.rejectionReason(null)));
                return;
            }
            runOnUiThread(() -> openReader(copied, displayName));
        } catch (DocumentLifecycleCoordinator.Failure failure) {
            String reason = IncomingPdfIntake.rejectionReason(failure.code());
            runOnUiThread(() -> refuse(reason));
        } catch (RuntimeException failure) {
            runOnUiThread(() -> refuse(IncomingPdfIntake.rejectionReason(null)));
        }
    }

    private static String displayNameOf(DocumentLifecycleCoordinator coordinator, String ref)
            throws DocumentLifecycleCoordinator.Failure {
        for (DocumentLifecycleCoordinator.DocumentRecord record : coordinator.listOwnedDocuments()) {
            if (record.ref().equals(ref) && record.available()
                    && PdfReaderLaunchContract.isSafeDisplayName(record.displayName())) {
                return record.displayName();
            }
        }
        return null;
    }

    private void openReader(String copied, String displayName) {
        if (isFinishing() || isDestroyed()) return;
        try {
            Intent intent = PdfReaderLaunchContract.createIntent(this, copied, displayName);
            spinner.setVisibility(View.GONE);
            ref = copied;
            reader.launch(intent);
        } catch (PdfReaderLaunchContract.Failure | RuntimeException failure) {
            ref = null;
            refuse(IncomingPdfIntake.rejectionReason(null));
        }
    }

    /** Closing the reader returns to the sending app; a chosen tool continues in the main app. */
    private void readerFinished(ActivityResult result) {
        String toolPath = null;
        try {
            toolPath = PdfReaderLaunchContract.parseResult(
                    result.getResultCode(), result.getData()).toolPath();
        } catch (PdfReaderLaunchContract.Failure | RuntimeException ignored) {
            // An unreadable answer is treated as a close.
        }
        String document = ref;
        String tool = toolPath;
        if (document != null && tool != null) {
            MainActivity.handOver(this, documents -> documents.announceIncomingPdf(document, tool));
        }
        finish();
    }

    /** The main app explains a refused file; null means the app is going away. */
    private void refuse(String reason) {
        if (reason != null && !isFinishing() && !isDestroyed()) {
            MainActivity.handOver(this, documents -> documents.announceIncomingPdfRejected(reason));
        }
        finish();
    }

    private void showDelayedSpinner() {
        FrameLayout root = new FrameLayout(this);
        spinner = new ProgressBar(this);
        spinner.setVisibility(View.GONE);
        root.addView(spinner, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER));
        setContentView(root);
        // Most copies finish well before this; a large one shows it is still working.
        root.postDelayed(() -> {
            if (ref == null && !isFinishing()) spinner.setVisibility(View.VISIBLE);
        }, SPINNER_DELAY_MILLIS);
    }
}
