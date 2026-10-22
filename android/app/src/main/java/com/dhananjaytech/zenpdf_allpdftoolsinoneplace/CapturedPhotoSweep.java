package com.dhananjaytech.zenpdf_allpdftoolsinoneplace;

import android.content.Context;
import android.os.Environment;
import java.io.File;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

/**
 * Removes the photos the WebView's camera capture parked in the app's own Pictures folder.
 *
 * Capacitor writes each shot as {@code JPEG_<stamp>_<random>.jpg} there and never deletes it.
 * Make PDF reads the bytes as soon as a shot arrives, so the files only take up space. Once per
 * process, before the page can start any capture, nothing can be using them. The stamp comes from
 * the phone's locale, so on Arabic, Persian, Marathi or Bengali phones its digits are not ASCII.
 */
final class CapturedPhotoSweep {
    static final Pattern CAPTURE_NAME = Pattern.compile("JPEG_\\p{Nd}{8}_\\p{Nd}{6}_\\p{Nd}+\\.jpg");
    private static final AtomicBoolean swept = new AtomicBoolean();

    private CapturedPhotoSweep() {}

    /** First call in a process deletes the leftovers off the main thread; later calls do nothing. */
    static void sweepOncePerProcess(Context context) {
        if (!swept.compareAndSet(false, true)) return;
        Thread thread = new Thread(() -> {
            try {
                discardCaptures(context.getExternalFilesDir(Environment.DIRECTORY_PICTURES));
            } catch (RuntimeException ignored) {
                // Tidying up is never worth interrupting the app.
            }
        }, "pdfchef-capture-sweep");
        thread.setDaemon(true);
        thread.start();
    }

    /** Deletes only the capture files themselves; anything else in the folder is left alone. */
    static int discardCaptures(File pictures) {
        File[] files = pictures == null ? null : pictures.listFiles();
        if (files == null) return 0;
        int deleted = 0;
        for (File file : files) {
            if (file.isFile() && CAPTURE_NAME.matcher(file.getName()).matches() && file.delete()) {
                deleted++;
            }
        }
        return deleted;
    }
}
