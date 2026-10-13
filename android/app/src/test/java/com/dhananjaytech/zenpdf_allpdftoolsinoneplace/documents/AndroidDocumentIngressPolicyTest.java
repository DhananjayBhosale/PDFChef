package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public final class AndroidDocumentIngressPolicyTest {
    private final AndroidDocumentIngressPolicy policy = new AndroidDocumentIngressPolicy();

    @Test public void acceptsExactActionsAndPdfContract() throws Exception {
        for (String action : List.of(
                AndroidDocumentIngressPolicy.ACTION_VIEW,
                AndroidDocumentIngressPolicy.ACTION_SEND,
                AndroidDocumentIngressPolicy.ACTION_SEND_MULTIPLE)) {
            AndroidDocumentIngressPolicy.ValidatedBatch result = policy.validate(
                    action, false, List.of(pdf("source-a", 12)));
            assertEquals(1, result.items().size());
            assertEquals(AndroidDocumentIngressPolicy.MIME_PDF,
                    result.items().get(0).mimeType());
        }
    }

    @Test public void rejectsUnknownActionAndBrowsableIngress() {
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () ->
                policy.validate("android.intent.action.EDIT", false, List.of(pdf("a", 12))));
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () ->
                policy.validate(AndroidDocumentIngressPolicy.ACTION_VIEW, true,
                        List.of(pdf("a", 12))));
    }

    @Test public void enforcesActionItemCountsAndGlobalCount() {
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () ->
                policy.validate(AndroidDocumentIngressPolicy.ACTION_VIEW, false,
                        List.of(pdf("a", 12), pdf("b", 12))));
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () ->
                policy.validate(AndroidDocumentIngressPolicy.ACTION_SEND, false, List.of()));

        ArrayList<AndroidDocumentIngressPolicy.Candidate> tooMany = new ArrayList<>();
        for (int i = 0; i <= AndroidDocumentIngressPolicy.MAX_ITEMS; i++) {
            tooMany.add(pdf("source-" + i, 1));
        }
        assertFailure("DOCUMENT_LIMIT_EXCEEDED", () ->
                policy.validate(AndroidDocumentIngressPolicy.ACTION_SEND_MULTIPLE, false, tooMany));
    }

    @Test public void rejectsNonContentAndNonExactMime() {
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () -> policy.validate(
                AndroidDocumentIngressPolicy.ACTION_VIEW, false,
                List.of(candidate("a", "file", AndroidDocumentIngressPolicy.MIME_PDF,
                        12, true, true, pdfMagic()))));
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () -> policy.validate(
                AndroidDocumentIngressPolicy.ACTION_VIEW, false,
                List.of(candidate("a", "CONTENT", AndroidDocumentIngressPolicy.MIME_PDF,
                        12, true, true, pdfMagic()))));
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () -> policy.validate(
                AndroidDocumentIngressPolicy.ACTION_VIEW, false,
                List.of(candidate("a", "content", "Application/Pdf",
                        12, true, true, pdfMagic()))));
    }

    @Test public void validatesReadGrantAndReadability() {
        assertFailure("DOCUMENT_UNAVAILABLE", () -> policy.validate(
                AndroidDocumentIngressPolicy.ACTION_VIEW, false,
                List.of(candidate("a", "content", AndroidDocumentIngressPolicy.MIME_PDF,
                        12, false, true, pdfMagic()))));
        assertFailure("DOCUMENT_UNAVAILABLE", () -> policy.validate(
                AndroidDocumentIngressPolicy.ACTION_VIEW, false,
                List.of(candidate("a", "content", AndroidDocumentIngressPolicy.MIME_PDF,
                        12, true, false, pdfMagic()))));
    }

    @Test public void validatesPositivePerItemAndAggregateSizes() throws Exception {
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () -> policy.validate(
                AndroidDocumentIngressPolicy.ACTION_VIEW, false, List.of(pdf("a", 0))));
        assertFailure("DOCUMENT_LIMIT_EXCEEDED", () -> policy.validate(
                AndroidDocumentIngressPolicy.ACTION_VIEW, false,
                List.of(pdf("a", AndroidDocumentIngressPolicy.MAX_ITEM_BYTES + 1))));

        AndroidDocumentIngressPolicy.Candidate first = pdf(
                "a", AndroidDocumentIngressPolicy.MAX_ITEM_BYTES - 1);
        AndroidDocumentIngressPolicy.Candidate second = pdf(
                "b", 1);
        assertEquals(2, policy.validate(AndroidDocumentIngressPolicy.ACTION_SEND_MULTIPLE,
                false, List.of(first, second)).items().size());
        assertFailure("DOCUMENT_LIMIT_EXCEEDED", () -> policy.validate(
                AndroidDocumentIngressPolicy.ACTION_SEND_MULTIPLE, false,
                List.of(first, second, pdf("c", 1))));
    }

    @Test public void rejectsDuplicateSourcesWithoutEchoingThem() {
        String sensitive = "content://private.provider/user/statement.pdf";
        try {
            policy.validate(AndroidDocumentIngressPolicy.ACTION_SEND_MULTIPLE, false,
                    List.of(pdf(sensitive, 12), pdf(sensitive, 12)));
            fail("Expected duplicate rejection");
        } catch (AndroidDocumentIngressPolicy.Failure failure) {
            assertEquals("DOCUMENT_INVALID_ARGUMENT", failure.code());
            assertEquals("The document request is invalid.", failure.getMessage());
            assertTrue(!failure.getMessage().contains(sensitive));
        }
    }

    @Test public void validatesClosedMimeMagicMatrix() throws Exception {
        assertMagic(AndroidDocumentIngressPolicy.MIME_PDF, pdfMagic());
        assertMagic(AndroidDocumentIngressPolicy.MIME_JPEG,
                new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0});
        assertMagic(AndroidDocumentIngressPolicy.MIME_PNG,
                new byte[] {(byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a});
        assertMagic(AndroidDocumentIngressPolicy.MIME_HEIC,
                new byte[] {0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63});
        assertMagic(AndroidDocumentIngressPolicy.MIME_DOCX,
                new byte[] {0x50, 0x4b, 0x03, 0x04});
        assertMagic(AndroidDocumentIngressPolicy.MIME_PPTX,
                new byte[] {0x50, 0x4b, 0x03, 0x04});

        assertFailure("DOCUMENT_CORRUPT", () ->
                policy.validateMagic(AndroidDocumentIngressPolicy.MIME_PDF,
                        new byte[] {0x50, 0x4b, 0x03, 0x04}));
        assertFailure("DOCUMENT_INVALID_ARGUMENT", () ->
                policy.validateMagic("text/plain", new byte[] {1, 2, 3, 4}));
    }

    private void assertMagic(String mimeType, byte[] bytes) throws Exception {
        policy.validateMagic(mimeType, bytes);
    }

    private static AndroidDocumentIngressPolicy.Candidate pdf(String source, long size) {
        return candidate(source, "content", AndroidDocumentIngressPolicy.MIME_PDF,
                size, true, true, pdfMagic());
    }

    private static AndroidDocumentIngressPolicy.Candidate candidate(
            String source, String scheme, String mime, long size,
            boolean grant, boolean readable, byte[] magic) {
        return new AndroidDocumentIngressPolicy.Candidate(
                source, scheme, mime, size, grant, readable, magic);
    }

    private static byte[] pdfMagic() {
        return new byte[] {0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37};
    }

    private static void assertFailure(String code, ThrowingRunnable runnable) {
        try {
            runnable.run();
            fail("Expected " + code);
        } catch (AndroidDocumentIngressPolicy.Failure failure) {
            assertEquals(code, failure.code());
        } catch (Exception unexpected) {
            throw new AssertionError(unexpected);
        }
    }

    private interface ThrowingRunnable { void run() throws Exception; }
}
