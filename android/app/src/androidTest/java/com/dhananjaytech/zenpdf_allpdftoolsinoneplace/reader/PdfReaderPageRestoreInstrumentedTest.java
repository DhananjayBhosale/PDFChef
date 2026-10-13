package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.swipeUp;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom;
import static androidx.test.espresso.matcher.ViewMatchers.isDisplayed;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.graphics.Paint;
import android.graphics.pdf.PdfDocument;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.PdfChefApplication;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.R;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.AndroidDocumentIngressPolicy;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.DocumentLifecycleCoordinator;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@RunWith(AndroidJUnit4.class)
public final class PdfReaderPageRestoreInstrumentedTest {
    private static final int PAGE_COUNT = 24;
    private static final Pattern PAGE_LABEL = Pattern.compile("Page ([0-9]+) of ([0-9]+)");

    @Test public void recreatingReaderRestoresTheExactVisiblePageWithoutCrashing() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        DocumentLifecycleCoordinator coordinator = ((PdfChefApplication)
                context.getApplicationContext()).getDocumentLifecycleCoordinator();
        DocumentLifecycleCoordinator.WriteSession write = coordinator.beginWrite(
                "Reader restore regression.pdf", AndroidDocumentIngressPolicy.MIME_PDF);
        DocumentLifecycleCoordinator.DocumentRecord document = null;
        try {
            coordinator.appendWrite(write.sessionId(), createPdf(), () -> false);
            document = coordinator.finishWrite(write.sessionId(), () -> false);

            try (ActivityScenario<PdfReaderActivity> scenario = ActivityScenario.launch(
                    PdfReaderLaunchContract.createIntent(context, document.ref(), document.displayName()))) {
                assertEquals(1, waitForPage(scenario, 1));

                int selectedPage = 1;
                for (int attempt = 0; attempt < 5 && selectedPage < 3; attempt++) {
                    onView(isAssignableFrom(androidx.pdf.view.PdfView.class))
                            .check(matches(isDisplayed()))
                            .perform(swipeUp());
                    selectedPage = waitForPageGreaterThan(scenario, selectedPage);
                }
                assertTrue("reader must move beyond page one", selectedPage > 1);

                for (int recreation = 0; recreation < 3; recreation++) {
                    scenario.recreate();
                    assertEquals("reader must restore the exact visible page",
                            selectedPage, waitForPage(scenario, selectedPage));

                    // The label is restored from saved state before the viewer scrolls.
                    // Moving forward proves the real viewport also reached that page:
                    // a silent fallback to page one would move to page two and fail.
                    onView(isAssignableFrom(androidx.pdf.view.PdfView.class))
                            .check(matches(isDisplayed()))
                            .perform(swipeUp());
                    int nextPage = waitForPageGreaterThan(scenario, selectedPage);
                    assertTrue("viewport must continue forward from page " + selectedPage + ", got " + nextPage,
                            nextPage > selectedPage);
                    selectedPage = nextPage;
                }
            }
        } finally {
            if (document != null) coordinator.deleteOwnedDocument(document.ref());
            else coordinator.abortWrite(write.sessionId());
        }
    }

    private static byte[] createPdf() throws Exception {
        PdfDocument pdf = new PdfDocument();
        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            Paint paint = new Paint();
            paint.setTextSize(24f);
            for (int pageNumber = 1; pageNumber <= PAGE_COUNT; pageNumber++) {
                PdfDocument.Page page = pdf.startPage(
                        new PdfDocument.PageInfo.Builder(600, 900, pageNumber).create());
                page.getCanvas().drawText("Reader restore page " + pageNumber, 48, 90, paint);
                pdf.finishPage(page);
            }
            pdf.writeTo(output);
            return output.toByteArray();
        } finally {
            pdf.close();
        }
    }

    private static int waitForPageGreaterThan(
            ActivityScenario<PdfReaderActivity> scenario, int previousPage) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        int page = previousPage;
        while (System.nanoTime() < deadline) {
            page = currentPage(scenario, true);
            // A swipe keeps advancing during its fling. Save the settled viewport, not an
            // intermediate page which can legitimately change before recreation starts.
            if (page > previousPage) return page;
            Thread.sleep(100);
        }
        return page;
    }

    private static androidx.pdf.view.PdfView findPdfView(View view) {
        if (view instanceof androidx.pdf.view.PdfView) return (androidx.pdf.view.PdfView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                androidx.pdf.view.PdfView pdf = findPdfView(group.getChildAt(index));
                if (pdf != null) return pdf;
            }
        }
        return null;
    }

    private static int waitForPage(
            ActivityScenario<PdfReaderActivity> scenario, int expectedPage) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        int page = -1;
        while (System.nanoTime() < deadline) {
            page = currentPage(scenario);
            if (page == expectedPage) return page;
            Thread.sleep(100);
        }
        return page;
    }

    private static int currentPage(ActivityScenario<PdfReaderActivity> scenario) {
        return currentPage(scenario, false);
    }

    private static int currentPage(ActivityScenario<PdfReaderActivity> scenario, boolean settledOnly) {
        AtomicReference<String> label = new AtomicReference<>("");
        scenario.onActivity(activity -> {
            if (settledOnly) {
                androidx.pdf.view.PdfView view = findPdfView(activity.findViewById(R.id.pdf_reader_container));
                if (view == null || view.getGestureState() != androidx.pdf.view.PdfView.GESTURE_STATE_IDLE) return;
            }
            label.set(((TextView) activity.findViewById(R.id.pdf_reader_page)).getText().toString());
        });
        Matcher matcher = PAGE_LABEL.matcher(label.get());
        if (!matcher.matches()) return -1;
        assertEquals(PAGE_COUNT, Integer.parseInt(matcher.group(2)));
        return Integer.parseInt(matcher.group(1));
    }
}
