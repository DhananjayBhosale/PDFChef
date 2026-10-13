package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class PdfReaderSearchEngineTest {
    @Test public void decryptedSearchScratchNeverUsesDiskAndRemainsBounded() {
        var memory = PdfReaderSearchEngine.searchMemory();
        assertTrue(memory.useMainMemory());
        assertFalse(memory.useTempFile());
        assertTrue(memory.isMainMemoryRestricted());
        assertTrue(memory.getMaxMainMemoryBytes() > 0);
        assertTrue(memory.getMaxMainMemoryBytes() <= 96L * 1024 * 1024);
    }

    @Test public void keepsOnlyMatchingPagesAndIgnoresCase() {
        FakePages pages = new FakePages("Alpha alpha", "nothing", "ALPHA and more");
        PdfReaderSearchEngine.Result result = PdfReaderSearchEngine.search(pages, " alpha ");

        assertEquals(PdfReaderSearchEngine.Status.COMPLETE, result.status);
        assertArrayEquals(new int[] {0, 2}, result.matchingPages);
        assertFalse(result.truncated);
        assertEquals(3, pages.readCount);
        assertEquals(1, pages.closeCount);
    }

    @Test public void rejectsUnsafeOrEmptyQueriesWithoutReadingPages() {
        for (String query : new String[] {"", "  ", "bad\u0000query",
                "x".repeat(PdfReaderSearchEngine.MAX_QUERY_CHARACTERS + 1)}) {
            FakePages pages = new FakePages("text");
            PdfReaderSearchEngine.Result result = PdfReaderSearchEngine.search(pages, query);
            assertEquals(PdfReaderSearchEngine.Status.INVALID_QUERY, result.status);
            assertEquals(0, pages.readCount);
            assertEquals(1, pages.closeCount);
        }
    }

    @Test public void interruptionStopsBeforeAnotherPageIsRead() {
        FakePages pages = new FakePages("one", "two");
        Thread.currentThread().interrupt();
        try {
            PdfReaderSearchEngine.Result result = PdfReaderSearchEngine.search(pages, "one");
            assertEquals(PdfReaderSearchEngine.Status.CANCELLED, result.status);
            assertEquals(0, pages.readCount);
            assertEquals(1, pages.closeCount);
        } finally {
            Thread.interrupted();
        }
    }

    private static final class FakePages implements PdfReaderSearchEngine.PageTextSource {
        private final String[] values;
        int readCount;
        int closeCount;

        FakePages(String... values) { this.values = values; }
        @Override public int pageCount() { return values.length; }
        @Override public String textForPage(int page) {
            readCount++;
            return values[page];
        }
        @Override public void close() { closeCount++; }
    }
}
