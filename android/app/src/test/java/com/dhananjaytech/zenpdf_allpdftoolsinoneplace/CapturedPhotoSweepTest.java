package com.dhananjaytech.zenpdf_allpdftoolsinoneplace;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.Test;

public final class CapturedPhotoSweepTest {
    @Test public void deletesOnlyCameraCapturesAndSurvivesAMissingFolder() throws Exception {
        Path pictures = Files.createTempDirectory("pdfchef-captures");
        Path capture = Files.createFile(pictures.resolve("JPEG_20261019_211500_1234567890.jpg"));
        Path other = Files.createFile(pictures.resolve("keep-me.jpg"));
        Path nested = Files.createDirectory(pictures.resolve("JPEG_20261019_211500_1.jpg.d"));

        assertEquals(1, CapturedPhotoSweep.discardCaptures(pictures.toFile()));
        assertFalse(Files.exists(capture));
        assertTrue(Files.exists(other));
        assertTrue(Files.isDirectory(nested));
        assertEquals(0, CapturedPhotoSweep.discardCaptures(pictures.toFile()));
        assertEquals(0, CapturedPhotoSweep.discardCaptures(new File(pictures.toFile(), "missing")));
        assertEquals(0, CapturedPhotoSweep.discardCaptures(null));
    }

    @Test public void theSweepRunsFromMainActivityResumeNotFromApplicationOrOnCreate() throws Exception {
        String activity = new String(Files.readAllBytes(java.nio.file.Paths.get(
                "src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/MainActivity.java")));
        assertEquals(1, activity.split("CapturedPhotoSweep\\.sweepOncePerProcess\\(this\\)", -1).length - 1);
        int resume = activity.indexOf("public void onResume()");
        int call = activity.indexOf("CapturedPhotoSweep.sweepOncePerProcess(this)");
        int next = activity.indexOf("    /**", resume);
        assertTrue(resume >= 0 && call > resume && call < next);
    }
}
