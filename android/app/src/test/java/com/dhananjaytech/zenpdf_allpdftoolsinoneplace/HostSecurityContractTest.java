package com.dhananjaytech.zenpdf_allpdftoolsinoneplace;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.Test;

/** Source-level guard for the no-telemetry host plus its one approved Google capability. */
public final class HostSecurityContractTest {
    @Test public void sourceHostAllowsOnlyThePinnedScannerAndNoTelemetryActivation()
            throws Exception {
        String rootBuild = source("android/build.gradle");
        String appBuild = source("android/app/build.gradle");
        String manifest = source("android/app/src/main/AndroidManifest.xml");

        for (String forbidden : new String[] {
                "com.google.gms:google-services", "com.google.gms.google-services",
                "google-services.json", "crashlytics", "analytics", "measurement", "admob"
        }) {
            assertFalse(forbidden, rootBuild.toLowerCase().contains(forbidden.toLowerCase()));
            assertFalse(forbidden, appBuild.toLowerCase().contains(forbidden.toLowerCase()));
            assertFalse(forbidden, manifest.toLowerCase().contains(forbidden.toLowerCase()));
        }
        assertTrue(appBuild.contains(
                "implementation 'com.google.android.gms:play-services-mlkit-document-scanner:16.0.0'"));
        assertFalse(appBuild.contains("exclude group:"));
        assertFalse(manifest.contains("<uses-permission"));
        assertTrue(manifest.contains("android:usesCleartextTraffic=\"false\""));
    }

    @Test public void productionIdentityAndBuildTypeContractsRemainExplicit() throws Exception {
        String appBuild = source("android/app/build.gradle");
        assertTrue(appBuild.contains("namespace = \"com.dhananjaytech.zenpdf_allpdftoolsinoneplace\""));
        assertTrue(appBuild.contains("applicationId \"com.dhananjaytech.pdfchef\""));
        assertTrue(appBuild.contains("applicationIdSuffix \".debug\""));
        assertTrue(appBuild.contains("minifyEnabled true"));
        assertTrue(appBuild.contains("shrinkResources true"));
        assertTrue(appBuild.contains("JavaVersion.VERSION_21"));
        assertTrue(appBuild.contains("androidx.datastore:datastore-preferences-proto:1.2.1"));
        assertTrue(appBuild.contains("com.google.code.gson:gson:2.13.2"));
    }

    @Test public void nativeReaderIsPrivateAndHasNoIndependentEntrySurface() throws Exception {
        String manifest = source("android/app/src/main/AndroidManifest.xml");
        assertEquals(1, occurrences(manifest,
                "android:name=\".reader.PdfReaderActivity\""));

        String reader = component(manifest, "<activity", ".reader.PdfReaderActivity");
        assertTrue(reader.contains("android:exported=\"false\""));
        assertTrue(reader.contains("android:theme=\"@style/PdfReaderTheme\""));
        assertTrue(reader.contains("android:windowSoftInputMode=\"adjustResize\""));
        for (String unsafe : new String[] {
                "android:exported=\"true\"", "<intent-filter", "android:permission=",
                "android:process=", "android:taskAffinity=", "android:launchMode=",
                "android:documentLaunchMode=", "android:screenOrientation="
        }) {
            assertFalse(unsafe, reader.contains(unsafe));
        }
    }

    private static String component(String manifest, String opening, String name) {
        int nameAt = manifest.indexOf(name);
        if (nameAt < 0) throw new AssertionError("Missing manifest component: " + name);
        int start = manifest.lastIndexOf(opening, nameAt);
        int selfClosingEnd = manifest.indexOf("/>", nameAt);
        int closingEnd = manifest.indexOf("</activity>", nameAt);
        int end = selfClosingEnd >= 0 && (closingEnd < 0 || selfClosingEnd < closingEnd)
                ? selfClosingEnd + 2 : closingEnd + "</activity>".length();
        if (start < 0 || end < start) {
            throw new AssertionError("Malformed manifest component: " + name);
        }
        return manifest.substring(start, end);
    }

    private static int occurrences(String source, String value) {
        int count = 0;
        for (int at = 0; (at = source.indexOf(value, at)) >= 0; at += value.length()) count++;
        return count;
    }

    private static String source(String relative) throws Exception {
        Path directory = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (directory != null) {
            Path file = directory.resolve(relative);
            if (Files.isRegularFile(file)) {
                return new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
            }
            directory = directory.getParent();
        }
        throw new AssertionError("Could not locate source: " + relative);
    }
}
