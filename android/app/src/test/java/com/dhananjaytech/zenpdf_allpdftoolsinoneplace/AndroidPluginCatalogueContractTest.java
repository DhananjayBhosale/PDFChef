package com.dhananjaytech.zenpdf_allpdftoolsinoneplace;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.DocumentLifecycleCoordinator;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.ReadOnlyDocumentFileProvider;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.Test;

public final class AndroidPluginCatalogueContractTest {
    @Test public void applicationsOwnOneFinalGraphLazyDocumentCoordinator() throws Exception {
        assertEquals(Application.class, PdfChefApplication.class.getSuperclass());
        Field document = PdfChefApplication.class.getDeclaredField("documentLifecycleCoordinator");
        assertEquals(DocumentLifecycleCoordinator.class, document.getType());
        assertTrue(Modifier.isPrivate(document.getModifiers()));
        assertTrue(Modifier.isFinal(document.getModifiers()));
        assertFalse(Modifier.isStatic(document.getModifiers()));
        PdfChefApplication application = new PdfChefApplication();
        assertSame(application.getDocumentLifecycleCoordinator(),
                application.getDocumentLifecycleCoordinator());
        Field graph = DocumentLifecycleCoordinator.class.getDeclaredField("graph");
        graph.setAccessible(true);
        assertEquals(null, graph.get(application.getDocumentLifecycleCoordinator()));
        assertNotNull(application.getLegacyMutationCoordinator());

        String release = source("src/release/java/com/dhananjaytech/"
                + "zenpdf_allpdftoolsinoneplace/PdfChefApplication.java");
        String debug = source("src/debug/java/com/dhananjaytech/"
                + "zenpdf_allpdftoolsinoneplace/PdfChefApplication.java");
        for (String variant : new String[] {release, debug}) {
            assertEquals(1, occurrences(variant, "new DocumentLifecycleCoordinator(this)"));
            assertEquals(1, occurrences(variant, "return documentLifecycleCoordinator;"));
            assertFalse(variant.contains("onCreate("));
            assertFalse(variant.contains("getFilesDir("));
        }
    }

    @Test public void registrationAndProviderCatalogueAreExact() throws Exception {
        String activity = source("src/main/java/com/dhananjaytech/"
                + "zenpdf_allpdftoolsinoneplace/MainActivity.java");
        int inspector = activity.indexOf("registerPlugin(AndroidLegacyInspectorPlugin.class)");
        int writer = activity.indexOf("registerPlugin(AndroidLegacySettingsWriterPlugin.class)");
        int metadata = activity.indexOf("registerPlugin(AndroidAppMetadataPlugin.class)");
        int storage = activity.indexOf("registerPlugin(AndroidStorageStatsPlugin.class)");
        int documents = activity.indexOf("registerPlugin(AndroidDocumentsPlugin.class)");
        int scanner = activity.indexOf("registerPlugin(AndroidDocumentScannerPlugin.class)");
        int support = activity.indexOf("registerPlugin(AndroidSupportPlugin.class)");
        int bridge = activity.indexOf("super.onCreate(savedInstanceState)");
        assertTrue(inspector >= 0 && inspector < writer && writer < metadata
                && metadata < storage && storage < documents && documents < scanner
                && scanner < support && support < bridge);
        assertEquals(7, occurrences(activity, "registerPlugin("));
        assertEquals(1, occurrences(activity, "registerPlugin(AndroidDocumentsPlugin.class)"));

        String manifest = source("src/main/AndroidManifest.xml");
        assertEquals(1, occurrences(manifest,
                "android:name=\".documents.ReadOnlyDocumentFileProvider\""));
        assertEquals(1, occurrences(manifest,
                "android:authorities=\"${applicationId}.fileprovider\""));
        assertEquals(2, occurrences(manifest, "android:exported=\"false\""));
        assertEquals(1, occurrences(manifest, "android:grantUriPermissions=\"true\""));
        assertTrue(Modifier.isFinal(ReadOnlyDocumentFileProvider.class.getModifiers()));
    }

    private static int occurrences(String source, String value) {
        int count = 0;
        for (int at = 0; (at = source.indexOf(value, at)) >= 0; at += value.length()) count++;
        return count;
    }

    private static String source(String relative) throws Exception {
        Path directory = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (directory != null) {
            Path app = Files.isDirectory(directory.resolve("src/main"))
                    ? directory : directory.resolve("android/app");
            Path file = app.resolve(relative);
            if (Files.isRegularFile(file)) {
                return new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
            }
            directory = directory.getParent();
        }
        throw new AssertionError("Could not locate " + relative);
    }
}
