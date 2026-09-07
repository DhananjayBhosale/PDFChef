package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import android.content.Context;
import android.content.ContentValues;
import android.graphics.pdf.PdfDocument;
import android.provider.MediaStore;
import android.os.ParcelFileDescriptor;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry;
import androidx.test.runner.lifecycle.Stage;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.MainActivity;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.R;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.PdfChefApplication;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader.PdfReaderActivity;
import java.io.OutputStream;
import java.util.HashSet;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import static org.junit.Assert.assertTrue;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class IncomingPdfIntakeInstrumentedTest {
    @Test public void acceptsContentViewAndShareButRejectsUnsafeIngress() {
        Uri uri = Uri.parse("content://documents/report.pdf");
        Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/pdf")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        assertTrue(IncomingPdfIntake.isIncomingPdf(view));
        Intent share = new Intent(Intent.ACTION_SEND).setType("application/pdf")
                .putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        assertTrue(IncomingPdfIntake.isIncomingPdf(share));
        Intent clip = new Intent(Intent.ACTION_SEND).setType("application/pdf")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        clip.setClipData(ClipData.newRawUri("PDF", uri));
        assertTrue(IncomingPdfIntake.isIncomingPdf(clip));
        assertFalse(IncomingPdfIntake.isIncomingPdf(null));
        assertFalse(IncomingPdfIntake.isIncomingPdf(new Intent(view).setFlags(0)));
        assertFalse(IncomingPdfIntake.isIncomingPdf(new Intent(view).addCategory(Intent.CATEGORY_BROWSABLE)));
        assertFalse(IncomingPdfIntake.isIncomingPdf(new Intent(view).setData(Uri.parse("file:///private.pdf"))));
        assertFalse(IncomingPdfIntake.isIncomingPdf(new Intent(view).setAction(Intent.ACTION_SEND_MULTIPLE)));
        assertFalse(IncomingPdfIntake.isIncomingPdf(new Intent(Intent.ACTION_SEND)
                .putExtra(Intent.EXTRA_STREAM, new Intent()).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)));
    }

    @Test public void externalViewLaunchOpensNativeReaderAfterColdWebBootstrap() throws Exception {
        var instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        var resolver = context.getContentResolver();
        var coordinator = ((PdfChefApplication) context.getApplicationContext()).getDocumentLifecycleCoordinator();
        HashSet<String> originalRefs = new HashSet<>();
        for (var item : coordinator.listOwnedDocuments()) originalRefs.add(item.ref());
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, "pdfchef-incoming-test-" + UUID.randomUUID() + ".pdf");
        values.put(MediaStore.Downloads.MIME_TYPE, "application/pdf");
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        assertTrue(uri != null);
        try {
            PdfDocument pdf = new PdfDocument();
            try (OutputStream output = resolver.openOutputStream(uri, "w")) {
                var page = pdf.startPage(new PdfDocument.PageInfo.Builder(300, 400, 1).create());
                page.getCanvas().drawText("Incoming PDF verification", 20, 40, new android.graphics.Paint());
                pdf.finishPage(page);
                pdf.writeTo(output);
            } finally {
                pdf.close();
            }
            ContentValues published = new ContentValues();
            published.put(MediaStore.Downloads.IS_PENDING, 0);
            assertEquals(1, resolver.update(uri, published, null, null));
            Intent intent = new Intent(context, MainActivity.class).setAction(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/pdf")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            context.startActivity(intent);
            try {
                AtomicBoolean readerOpened = new AtomicBoolean();
                long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(30);
                while (!readerOpened.get() && System.nanoTime() < deadline) {
                    instrumentation.runOnMainSync(() -> {
                        for (var activity : ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)) {
                            if (activity instanceof PdfReaderActivity
                                    && activity.findViewById(R.id.pdf_reader_container).getVisibility() == android.view.View.VISIBLE
                                    && activity.findViewById(R.id.pdf_reader_error).getVisibility() != android.view.View.VISIBLE) {
                                readerOpened.set(true);
                            }
                        }
                    });
                    if (!readerOpened.get()) Thread.sleep(100);
                }
                assertTrue("External PDF must open the reader after web bootstrap", readerOpened.get());
                android.graphics.Bitmap screenshot = instrumentation.getUiAutomation().takeScreenshot();
                try (OutputStream output = new java.io.FileOutputStream(new java.io.File(context.getCacheDir(), "audit-incoming-reader.png"))) {
                    screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
                } finally { screenshot.recycle(); }
            } finally {
                instrumentation.runOnMainSync(() -> {
                    for (Stage stage : java.util.List.of(Stage.RESUMED, Stage.STARTED, Stage.STOPPED, Stage.PAUSED)) {
                        for (var activity : new java.util.ArrayList<>(ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(stage))) {
                            if (activity instanceof PdfReaderActivity || activity instanceof MainActivity) activity.finish();
                        }
                    }
                });
            }
        } finally {
            resolver.delete(uri, null, null);
            for (var item : coordinator.listOwnedDocuments()) {
                if (!originalRefs.contains(item.ref())) coordinator.deleteOwnedDocument(item.ref());
            }
        }
    }

}
