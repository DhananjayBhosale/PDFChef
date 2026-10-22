package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.Test;

/** CNV-11: cancelling the password prompt said the PDF could not be opened and may be damaged. */
public final class PdfReaderPasswordPromptContractTest {
    @Test public void cancellingThePasswordPromptClosesTheReader() throws Exception {
        String reader = source("src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/"
                + "reader/PdfReaderActivity.java");
        assertTrue(reader.contains(
                ".setNegativeButton(android.R.string.cancel, (dialog, which) -> finishClosed())"));
        assertTrue(reader.contains(".setOnCancelListener(dialog -> finishClosed())"));
        // The viewer's own cancel fails the load, and a failed load shows the damaged-file screen.
        assertFalse(reader.contains("passwordDialogCancelled"));
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
