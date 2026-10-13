package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;
import com.tom_roush.pdfbox.io.MemoryUsageSetting;
import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.text.PDFTextStripper;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Locale;

/**
 * Background-only reader search.
 *
 * AndroidX PDF's built-in search creates every highlight on the main thread. A document with many
 * matches can therefore stop input dispatch long enough to produce an ANR. This implementation
 * reads one page at a time away from the UI thread and retains only matching page numbers. The
 * reader can still move to previous and next results without ever constructing an unbounded list
 * of highlight rectangles.
 */
final class PdfReaderSearchEngine {
    static final int MAX_QUERY_CHARACTERS = 160;
    static final int MAX_RESULT_PAGES = 4_096;
    private static final long PDFBOX_MEMORY_BYTES = 96L * 1024L * 1024L;

    enum Status { COMPLETE, INVALID_QUERY, CANCELLED, UNAVAILABLE }

    static final class Result {
        final Status status;
        final int[] matchingPages;
        final boolean truncated;

        Result(Status status, int[] matchingPages, boolean truncated) {
            this.status = status;
            this.matchingPages = matchingPages;
            this.truncated = truncated;
        }
    }

    interface PageTextSource extends AutoCloseable {
        int pageCount();
        String textForPage(int zeroBasedPage) throws Exception;
        @Override void close() throws Exception;
    }

    private final Context context;

    PdfReaderSearchEngine(@NonNull Context context) {
        this.context = context.getApplicationContext();
    }

    Result search(@NonNull Path snapshot, @Nullable char[] password, @Nullable String query) {
        char[] submittedPassword = password == null ? new char[0] : password;
        try {
            PDFBoxResourceLoader.init(context);
            PDDocument document = PDDocument.load(
                    snapshot.toFile(), new String(submittedPassword), searchMemory());
            try {
                return search(new PdfBoxPages(document), query);
            } catch (Exception constructorFailure) {
                document.close();
                throw constructorFailure;
            }
        } catch (Exception | LinkageError | OutOfMemoryError unavailable) {
            return new Result(Status.UNAVAILABLE, new int[0], false);
        } finally {
            Arrays.fill(submittedPassword, '\0');
        }
    }

    static MemoryUsageSetting searchMemory() {
        // PDFBox's scratch streams contain decrypted bytes. Keep them off disk even when
        // Android kills the search process before PDDocument.close() can run.
        return MemoryUsageSetting.setupMainMemoryOnly(PDFBOX_MEMORY_BYTES);
    }

    static Result search(@NonNull PageTextSource source, @Nullable String rawQuery) {
        String query = normalizedQuery(rawQuery);
        if (query == null) {
            closeQuietly(source);
            return new Result(Status.INVALID_QUERY, new int[0], false);
        }

        ArrayList<Integer> pages = new ArrayList<>();
        boolean truncated = false;
        try (source) {
            int pageCount = source.pageCount();
            if (pageCount < 0) return new Result(Status.UNAVAILABLE, new int[0], false);
            for (int page = 0; page < pageCount; page++) {
                if (Thread.currentThread().isInterrupted()) {
                    return new Result(Status.CANCELLED, new int[0], false);
                }
                String text = source.textForPage(page);
                if (text != null && text.toLowerCase(Locale.ROOT).contains(query)) {
                    if (pages.size() >= MAX_RESULT_PAGES) {
                        truncated = true;
                        break;
                    }
                    pages.add(page);
                }
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return new Result(Status.CANCELLED, new int[0], false);
        } catch (Exception unavailable) {
            return new Result(Status.UNAVAILABLE, new int[0], false);
        }

        int[] matches = new int[pages.size()];
        for (int index = 0; index < pages.size(); index++) matches[index] = pages.get(index);
        return new Result(Status.COMPLETE, matches, truncated);
    }

    @Nullable
    private static String normalizedQuery(@Nullable String rawQuery) {
        if (rawQuery == null) return null;
        String query = rawQuery.strip();
        if (query.isEmpty() || query.length() > MAX_QUERY_CHARACTERS) return null;
        for (int index = 0; index < query.length(); index++) {
            char value = query.charAt(index);
            if (Character.isISOControl(value) && !Character.isWhitespace(value)) return null;
        }
        return query.toLowerCase(Locale.ROOT);
    }

    private static void closeQuietly(PageTextSource source) {
        try { source.close(); }
        catch (Exception ignored) { }
    }

    private static final class PdfBoxPages implements PageTextSource {
        private final PDDocument document;
        private final PDFTextStripper stripper;

        PdfBoxPages(PDDocument document) throws Exception {
            this.document = document;
            this.stripper = new PDFTextStripper();
            stripper.setSortByPosition(true);
        }

        @Override public int pageCount() {
            return document.getNumberOfPages();
        }

        @Override public String textForPage(int zeroBasedPage) throws Exception {
            if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
            int oneBasedPage = zeroBasedPage + 1;
            stripper.setStartPage(oneBasedPage);
            stripper.setEndPage(oneBasedPage);
            return stripper.getText(document);
        }

        @Override public void close() throws Exception {
            document.close();
        }
    }
}
