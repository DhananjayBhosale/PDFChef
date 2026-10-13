package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.action.ViewActions.replaceText;
import static androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom;
import static androidx.test.espresso.matcher.ViewMatchers.withText;
import static org.junit.Assert.*;

import android.content.Context;
import android.os.Bundle;
import android.os.Parcel;
import android.widget.EditText;
import android.widget.TextView;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.PdfChefApplication;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.R;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.AndroidDocumentIngressPolicy;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.DocumentLifecycleCoordinator;
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;
import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.pdmodel.PDPage;
import com.tom_roush.pdfbox.pdmodel.encryption.AccessPermission;
import com.tom_roush.pdfbox.pdmodel.encryption.StandardProtectionPolicy;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

@RunWith(AndroidJUnit4.class)
public final class PdfReaderLifecycleInstrumentedTest {
    private static final String PASSWORD = " spaced password ";

    @Test public void passwordRequestedWhileStoppedIsDeferredAndRetryStillOpensPdf() throws Exception {
        try (Fixture fixture = new Fixture(true);
             ActivityScenario<PdfReaderActivity> scenario = fixture.launch()) {
            waitForPassword(scenario);
            AtomicReference<PdfReaderActivity.ReaderFragment> fragment = new AtomicReference<>();
            scenario.onActivity(activity -> fragment.set((PdfReaderActivity.ReaderFragment)
                    activity.getSupportFragmentManager().findFragmentByTag("pdfchef.reader.fragment")));
            scenario.onActivity(activity -> fragment.get().submitPassword("wrong"));
            scenario.moveToState(Lifecycle.State.CREATED);
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
                assertNull("loading viewer must release its background UI collector",
                        fragment.get().getView());
                assertFalse("the old viewer and its load job must be removed", fragment.get().isAdded());
            });
            Thread.sleep(500);
            scenario.moveToState(Lifecycle.State.RESUMED);
            waitForPassword(scenario);
            scenario.recreate();
            waitForPassword(scenario);
            onView(isAssignableFrom(EditText.class)).perform(replaceText("wrong"));
            onView(withText(R.string.pdf_reader_password_open)).perform(click());
            waitForPassword(scenario);
            onView(isAssignableFrom(EditText.class)).perform(replaceText(PASSWORD));
            onView(withText(R.string.pdf_reader_password_open)).perform(click());
            waitForDocument(scenario);
            scenario.onActivity(activity -> fragment.set((PdfReaderActivity.ReaderFragment)
                    activity.getSupportFragmentManager().findFragmentByTag("pdfchef.reader.fragment")));
            scenario.moveToState(Lifecycle.State.CREATED);
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
                    assertNotNull("an already loaded PDF must remain mounted", fragment.get().getView()));
            scenario.moveToState(Lifecycle.State.RESUMED);
            waitForDocument(scenario);
            scenario.recreate();
            waitForDocument(scenario);
        }
    }

    @Test public void readerSavesOnlySmallReopenStateNotDocumentOrViewHierarchy() throws Exception {
        try (Fixture fixture = new Fixture(false);
             ActivityScenario<PdfReaderActivity> scenario = fixture.launch()) {
            waitForDocument(scenario);
            AtomicReference<Bundle> saved = new AtomicReference<>();
            scenario.onActivity(activity -> {
                try {
                    Bundle state = new Bundle();
                    state.putByteArray("large.transient.view.state", new byte[2 * 1024 * 1024]);
                    Method save = PdfReaderActivity.class.getDeclaredMethod("onSaveInstanceState", Bundle.class);
                    save.setAccessible(true);
                    save.invoke(activity, state);
                    saved.set(state);
                } catch (Exception failure) {
                    throw new AssertionError(failure);
                }
            });
            Bundle state = saved.get();
            assertEquals(4, state.size());
            assertEquals(1, state.getInt("pdfchef.reader.page"));
            assertFalse(state.containsKey("large.transient.view.state"));
            Parcel parcel = Parcel.obtain();
            try {
                parcel.writeBundle(state);
                assertTrue("reader state must stay well below Binder limits", parcel.dataSize() < 8192);
            } finally {
                parcel.recycle();
            }
            scenario.recreate();
            waitForDocument(scenario);
        }
    }

    private static void waitForPassword(ActivityScenario<PdfReaderActivity> scenario) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        AtomicReference<Boolean> visible = new AtomicReference<>(false);
        while (System.nanoTime() < deadline) {
            scenario.onActivity(activity -> {
                try {
                    Field field = PdfReaderActivity.class.getDeclaredField("passwordDialog");
                    field.setAccessible(true);
                    android.app.Dialog dialog = (android.app.Dialog) field.get(activity);
                    visible.set(dialog != null && dialog.isShowing());
                    if (visible.get()) {
                        androidx.fragment.app.Fragment viewer = activity.getSupportFragmentManager()
                                .findFragmentByTag("pdfchef.reader.fragment");
                        androidx.fragment.app.Fragment stock = viewer == null ? null
                                : viewer.getChildFragmentManager().findFragmentByTag("password-dialog");
                        if (stock instanceof androidx.fragment.app.DialogFragment) {
                            android.app.Dialog sdkDialog = ((androidx.fragment.app.DialogFragment) stock).getDialog();
                            assertTrue("only PDF Chef's password prompt may be visible",
                                    sdkDialog == null || !sdkDialog.isShowing());
                        }
                    }
                } catch (Exception failure) { throw new AssertionError(failure); }
            });
            if (visible.get()) return;
            Thread.sleep(100);
        }
        fail("password prompt did not appear");
    }

    private static void waitForDocument(ActivityScenario<PdfReaderActivity> scenario) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        AtomicReference<String> label = new AtomicReference<>("");
        while (System.nanoTime() < deadline) {
            scenario.onActivity(activity -> label.set(((TextView)
                    activity.findViewById(R.id.pdf_reader_page)).getText().toString()));
            if ("Page 1 of 1".equals(label.get())) return;
            Thread.sleep(100);
        }
        fail("PDF did not open: " + label.get());
    }

    private static final class Fixture implements AutoCloseable {
        private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        private final DocumentLifecycleCoordinator coordinator = ((PdfChefApplication)
                context.getApplicationContext()).getDocumentLifecycleCoordinator();
        private final DocumentLifecycleCoordinator.DocumentRecord record;

        Fixture(boolean encrypted) throws Exception {
            PDFBoxResourceLoader.init(context);
            byte[] bytes;
            try (PDDocument pdf = new PDDocument(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                pdf.addPage(new PDPage());
                if (encrypted) {
                    StandardProtectionPolicy policy = new StandardProtectionPolicy(
                            "fixture-owner", PASSWORD, new AccessPermission());
                    policy.setEncryptionKeyLength(128);
                    pdf.protect(policy);
                }
                pdf.save(output);
                bytes = output.toByteArray();
            }
            DocumentLifecycleCoordinator.WriteSession write = coordinator.beginWrite(
                    "Lifecycle regression.pdf", AndroidDocumentIngressPolicy.MIME_PDF);
            try {
                coordinator.appendWrite(write.sessionId(), bytes, () -> false);
                record = coordinator.finishWrite(write.sessionId(), () -> false);
            } catch (Exception failure) {
                coordinator.abortWrite(write.sessionId());
                throw failure;
            }
        }

        ActivityScenario<PdfReaderActivity> launch() throws Exception {
            return ActivityScenario.launch(PdfReaderLaunchContract.createIntent(
                    context, record.ref(), record.displayName()));
        }

        @Override public void close() throws Exception {
            coordinator.deleteOwnedDocument(record.ref());
        }
    }
}
