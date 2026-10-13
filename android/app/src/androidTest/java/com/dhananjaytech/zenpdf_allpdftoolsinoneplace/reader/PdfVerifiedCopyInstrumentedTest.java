package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;
import com.tom_roush.pdfbox.cos.COSArray;
import com.tom_roush.pdfbox.cos.COSDictionary;
import com.tom_roush.pdfbox.cos.COSName;
import com.tom_roush.pdfbox.cos.COSObject;
import com.tom_roush.pdfbox.cos.COSStream;
import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.pdmodel.PDPage;
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream;
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle;
import com.tom_roush.pdfbox.pdmodel.graphics.form.PDFormXObject;
import com.tom_roush.pdfbox.pdmodel.interactive.form.PDField;
import com.tom_roush.pdfbox.pdmodel.encryption.InvalidPasswordException;
import com.tom_roush.pdfbox.pdmodel.encryption.AccessPermission;
import com.tom_roush.pdfbox.pdmodel.encryption.StandardProtectionPolicy;
import com.tom_roush.pdfbox.text.PDFTextStripper;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import java.util.stream.Stream;

@RunWith(AndroidJUnit4.class)
public final class PdfVerifiedCopyInstrumentedTest {
    private static final Date CHECKED_AT = Date.from(Instant.parse("2026-09-27T09:30:00Z"));

    @Test public void layeredRc4CopyKeepsPasswordFlattensStatusAndPreservesOriginal() throws Exception {
        Context context = context();
        Path snapshot = fixture(context, "layered-appearance-rc4.pdf");
        byte[] before = hash(snapshot);
        char[] password = "fixture-user".toCharArray();
        PdfVerifiedCopy.Result result = null;
        try {
            // Real CMS and PKIX checks with only the fixture root added as a test trust anchor.
            assertTrue(PdfSignatureReport.fullyVerified(fixtureVerifier(context).verify(snapshot, password)));
            result = PdfVerifiedCopy.create(context, snapshot, password, "Signed document.pdf", CHECKED_AT, outputDir(context));
            assertEquals(PdfVerifiedCopy.Outcome.CREATED, result.outcome);
            assertEquals("Signed document (verified copy).pdf", result.path.getFileName().toString());
            assertTrue(result.encrypted);
            for (String wrong : new String[] {"", "wrong-password"}) {
                try (PDDocument ignored = PDDocument.load(result.path.toFile(), wrong)) {
                    fail("Copy must reject missing or wrong user password");
                } catch (InvalidPasswordException expected) { }
            }
            try (PDDocument copy = PDDocument.load(result.path.toFile(), "fixture-user")) {
                assertTrue(copy.isEncrypted());
                assertTrue(copy.getEncryption().getLength() >= 128);
                assertTrue(copy.getEncryption().getVersion() >= 4);
                assertTrue(copy.getCurrentAccessPermission().canPrint());
                assertTrue(copy.getCurrentAccessPermission().canExtractContent());
                assertTrue(copy.getSignatureFields().isEmpty());
                // The note records when the report checked the signature, not when the copy was made.
                assertEquals(PdfVerifiedCopy.provenanceNote(CHECKED_AT),
                        copy.getDocumentInformation().getSubject());
                assertTrue(copy.getSignatureDictionaries().isEmpty());
                assertFalse(copy.getDocumentCatalog().getAcroForm().getCOSObject().containsKey(COSName.SIG_FLAGS));
                for (PDPage page : copy.getPages()) {
                    assertTrue(page.getAnnotations().stream().noneMatch(annotation ->
                            COSName.WIDGET.equals(annotation.getCOSObject().getCOSName(COSName.SUBTYPE))));
                }
                String text = new PDFTextStripper().getText(copy);
                assertTrue(text.contains("Signature valid"));
                assertTrue(text.contains("Digitally signed by DS PDF Chef"));
                assertFalse(text.contains("Signature Not Verified"));
                // The actual flattened form carries the exact tick stream and original BBox.
                PDPage page = copy.getPage(0);
                boolean tickFound = false;
                for (COSName name : page.getResources().getXObjectNames()) {
                    COSDictionary appearance = page.getResources().getXObject(name).getCOSObject();
                    COSStream frm = xobject(appearance, "FRM");
                    if (frm == null) continue;
                    COSStream n1 = xobject(frm, "n1");
                    if (n1 == null) continue;
                    assertEquals("% DSValid\nq 0.13 0.62 0.29 rg 14 52 m 40 22 l 88 80 l 78 88 l 40 42 l 24 62 h f Q\n", content(n1));
                    assertArrayEquals(new float[] {0, 0, 100, 100}, n1.getCOSArray(COSName.BBOX).toFloatArray(), 0);
                    assertEquals("% DSBlank\n", content(xobject(frm, "n3")));
                    tickFound = true;
                }
                assertTrue(tickFound);
            }
            assertArrayEquals(before, hash(snapshot));
        } finally {
            Arrays.fill(password, '\0');
            deleteCopy(result);
            Files.deleteIfExists(snapshot);
        }
    }

    @Test public void mixedOffsetCopyMarksOnlySignedWidgetAndKeepsUnsignedField() throws Exception {
        Context context = context();
        Path snapshot = fixture(context, "layered-mixed-offset-rc4.pdf");
        byte[] before = hash(snapshot);
        PdfVerifiedCopy.Result result = null;
        try {
            assertTrue(PdfSignatureReport.fullyVerified(fixtureVerifier(context).verify(snapshot, "fixture-user".toCharArray())));
            result = PdfVerifiedCopy.create(context, snapshot, "fixture-user".toCharArray(), "Mixed.pdf", CHECKED_AT, outputDir(context));
            assertEquals(PdfVerifiedCopy.Outcome.CREATED, result.outcome);
            try (PDDocument copy = PDDocument.load(result.path.toFile(), "fixture-user")) {
                assertTrue(copy.isEncrypted());
                assertTrue(copy.getSignatureDictionaries().isEmpty());
                assertEquals(1, copy.getSignatureFields().size());
                assertTrue(copy.getSignatureFields().stream().allMatch(field -> field.getSignature() == null));
                PDField unsigned = copy.getDocumentCatalog().getAcroForm().getField("Signature2");
                assertTrue(unsigned != null);
                assertFalse(unsigned.getCOSObject().containsKey(COSName.V));
                PDPage page = copy.getPage(0);
                assertArrayEquals(new float[] {100, 100, 300, 300}, page.getMediaBox().getCOSArray().toFloatArray(), 0);
                assertEquals(1, page.getAnnotations().size());
                assertArrayEquals(new float[] {220, 200, 270, 230},
                        page.getAnnotations().get(0).getRectangle().getCOSArray().toFloatArray(), 0);
                COSStream normal = page.getAnnotations().get(0).getNormalAppearanceStream().getCOSObject();
                assertTrue(content(xobject(xobject(normal, "FRM"), "n1")).contains("DSUnknown"));
                assertTrue(content(xobject(xobject(normal, "FRM"), "n4")).contains("Signature Not Verified"));
                // PDFTextStripper reads page content, not annotations. Draw the untouched AP on
                // an extra in-memory page for extraction only; never save this test-only change.
                PDPage annotationPage = new PDPage(new PDRectangle(300, 300));
                copy.addPage(annotationPage);
                try (PDPageContentStream content = new PDPageContentStream(copy, annotationPage)) {
                    content.drawForm(new PDFormXObject(normal));
                }
                String text = new PDFTextStripper().getText(copy);
                assertEquals(1, occurrences(text, "Signature valid"));
                assertEquals(1, occurrences(text, "Signature Not Verified"));
            }
            assertArrayEquals(before, hash(snapshot));
        } finally {
            deleteCopy(result);
            Files.deleteIfExists(snapshot);
        }
    }

    @Test public void hexStatusRejectsEntireCopyWithoutWritingAFile() throws Exception {
        Context context = context();
        Path snapshot = fixture(context, "layered-hex-status-rc4.pdf");
        Path output = Files.createTempDirectory(context.getCacheDir().toPath(), "unsupported-copy-");
        byte[] before = hash(snapshot);
        try {
            PdfVerifiedCopy.Result result = PdfVerifiedCopy.create(context, snapshot, "fixture-user".toCharArray(),
                    "Hex.pdf", CHECKED_AT, output);
            assertEquals(PdfVerifiedCopy.Outcome.UNSUPPORTED_SIGNATURE_BOX, result.outcome);
            assertNull(result.path);
            try (Stream<Path> files = Files.list(output)) { assertEquals(0, files.count()); }
            assertEquals(PdfVerifiedCopy.Outcome.UNSUPPORTED_SIGNATURE_BOX,
                    PdfVerifiedCopy.prepareForPrint(context, snapshot, "fixture-user".toCharArray()).outcome);
            assertArrayEquals(before, hash(snapshot));
        } finally {
            Files.deleteIfExists(snapshot);
            Files.deleteIfExists(output);
        }
    }

    @Test public void invisibleSignedWidgetAndWidgetlessSignedFieldAreRemoved() throws Exception {
        Context context = context();
        Path source = fixture(context, "layered-appearance-rc4.pdf");
        Path snapshot = Files.createTempFile(context.getCacheDir().toPath(), "invisible-signed-", ".pdf");
        PdfVerifiedCopy.Result result = null;
        try {
            // Structural fixture only: all signed fields share the checked dictionary identity.
            try (PDDocument document = PDDocument.load(source.toFile(), "fixture-user")) {
                COSArray annots = document.getPage(0).getCOSObject().getCOSArray(COSName.ANNOTS);
                COSDictionary signed = (COSDictionary) annots.getObject(0);
                COSDictionary invisible = new COSDictionary(signed);
                invisible.setString(COSName.T, "Invisible signed");
                invisible.setItem(COSName.RECT, new PDRectangle().getCOSArray());
                annots.add(invisible);
                COSDictionary hidden = new COSDictionary(signed);
                hidden.setString(COSName.T, "Hidden signed");
                hidden.setInt(COSName.F, 2);
                annots.add(hidden);
                COSArray fields = document.getDocumentCatalog().getAcroForm().getCOSObject().getCOSArray(COSName.FIELDS);
                fields.add(invisible);
                fields.add(hidden);
                COSDictionary widgetless = new COSDictionary();
                widgetless.setItem(COSName.FT, COSName.SIG);
                widgetless.setString(COSName.T, "Widgetless signed");
                widgetless.setItem(COSName.V, signed.getItem(COSName.V));
                fields.add(widgetless);
                document.setAllSecurityToBeRemoved(true);
                document.save(snapshot.toFile());
            }
            result = PdfVerifiedCopy.create(context, snapshot, null, "Invisible.pdf", CHECKED_AT, outputDir(context));
            assertEquals(PdfVerifiedCopy.Outcome.CREATED, result.outcome);
            try (PDDocument copy = PDDocument.load(result.path.toFile())) {
                assertTrue(copy.getSignatureFields().isEmpty());
                assertTrue(copy.getSignatureDictionaries().isEmpty());
                assertTrue(copy.getPage(0).getAnnotations().isEmpty());
                assertFalse(copy.getDocumentCatalog().getAcroForm().getCOSObject().containsKey(COSName.SIG_FLAGS));
                // The hidden box is removed without being drawn, so only one box says valid.
                assertEquals(1, occurrences(new PDFTextStripper().getText(copy), "Signature valid"));
            }
        } finally {
            deleteCopy(result);
            Files.deleteIfExists(snapshot);
            Files.deleteIfExists(source);
        }
    }

    @Test public void unsupportedSharePasswordsStillPrintWithoutACacheCopy() throws Exception {
        Context context = context();
        Path source = fixture(context, "layered-appearance-rc4.pdf");
        Path snapshot = Files.createTempFile(context.getCacheDir().toPath(), "password-boundary-", ".pdf");
        Path output = Files.createTempDirectory(context.getCacheDir().toPath(), "password-copy-");
        try {
            for (String password : new String[] {"café", "123456789012345678901234567890123"}) {
                // Structural variants: test the writers, not the cryptographic verification gate.
                try (PDDocument document = PDDocument.load(source.toFile(), "fixture-user")) {
                    StandardProtectionPolicy policy = new StandardProtectionPolicy("test-owner", password, new AccessPermission());
                    policy.setEncryptionKeyLength(128);
                    policy.setPreferAES(true);
                    document.protect(policy);
                    document.save(snapshot.toFile());
                }
                PdfVerifiedCopy.Result result = PdfVerifiedCopy.create(context, snapshot, password.toCharArray(), "Password.pdf", CHECKED_AT, output);
                assertEquals(PdfVerifiedCopy.Outcome.PASSWORD_UNSUPPORTED, result.outcome);
                assertNull(result.path);
                assertEquals(PdfVerifiedCopy.Outcome.CREATED,
                        PdfVerifiedCopy.prepareForPrint(context, snapshot, password.toCharArray()).outcome);
                ByteArrayOutputStream spool = new ByteArrayOutputStream();
                PdfVerifiedCopy.writeForPrint(snapshot, password.toCharArray(), CHECKED_AT, spool);
                try (PDDocument printed = PDDocument.load(spool.toByteArray())) {
                    assertFalse(printed.isEncrypted());
                    assertTrue(printed.getSignatureDictionaries().isEmpty());
                    assertEquals(1, occurrences(new PDFTextStripper().getText(printed), "Signature valid"));
                    assertEquals("PDF Chef", printed.getDocumentInformation().getCreator());
                }
                try (Stream<Path> files = Files.list(output)) { assertEquals(0, files.count()); }
            }
        } finally {
            Files.deleteIfExists(snapshot);
            Files.deleteIfExists(source);
            Files.deleteIfExists(output);
        }
    }

    private static int occurrences(String text, String needle) {
        return (text.length() - text.replace(needle, "").length()) / needle.length();
    }

    @Test public void invisibleCadesSignatureHasNoBoxAndWritesNoCopy() throws Exception {
        Context context = context();
        Path snapshot = fixture(context, "cades-sha256-plain.pdf");
        byte[] before = hash(snapshot);
        try {
            assertTrue(PdfSignatureReport.fullyVerified(fixtureVerifier(context).verify(snapshot)));
            PdfVerifiedCopy.Result result = PdfVerifiedCopy.create(context, snapshot, null,
                    "Invisible.pdf", CHECKED_AT, outputDir(context));
            assertEquals(PdfVerifiedCopy.Outcome.NO_SIGNATURE_BOX, result.outcome);
            assertNull(result.path);
            assertArrayEquals(before, hash(snapshot));
        } finally {
            Files.deleteIfExists(snapshot);
        }
    }

    @Test public void inheritedSignatureTypeAndUnrelatedWidgetSurviveSelectiveFlattening() throws Exception {
        Context context = context();
        Path fixture = fixture(context, "layered-appearance-rc4.pdf");
        Path snapshot = Files.createTempFile(context.getCacheDir().toPath(), "parent-field-", ".pdf");
        PdfVerifiedCopy.Result result = null;
        try {
            // A structural variant, not a cryptographic fixture: exercise /Parent inheritance,
            // a missing /P, and preserving a second, non-layered widget on the same page.
            try (PDDocument document = PDDocument.load(fixture.toFile(), "fixture-user")) {
                COSArray annots = document.getPage(0).getCOSObject().getCOSArray(COSName.ANNOTS);
                COSDictionary widget = (COSDictionary) annots.getObject(0);
                // The parent field is its own indirect object, as signing tools write it, so the
                // verifier and the copier both reach the signature through it.
                COSDictionary parent = new COSDictionary();
                parent.setItem(COSName.FT, COSName.SIG);
                parent.setString(COSName.T, "Signature parent");
                parent.setItem(COSName.V, widget.getItem(COSName.V));
                COSArray kids = new COSArray();
                kids.add(widget);
                parent.setItem(COSName.KIDS, kids);
                COSObject parentObject = new COSObject(parent);
                widget.removeItem(COSName.FT);
                widget.removeItem(COSName.V);
                widget.removeItem(COSName.P);
                widget.removeItem(COSName.T);
                widget.setItem(COSName.PARENT, parentObject);
                COSDictionary other = new COSDictionary();
                other.setItem(COSName.SUBTYPE, COSName.WIDGET);
                other.setItem(COSName.FT, COSName.TX);
                other.setString(COSName.T, "Keep this field");
                other.setString(COSName.V, "Keep this value");
                // Shared AP must not inherit the tick from the selected signature widget.
                other.setItem(COSName.AP, widget.getItem(COSName.AP));
                annots.add(other);
                COSArray fields = new COSArray();
                fields.add(parentObject);
                fields.add(other);
                document.getDocumentCatalog().getAcroForm().getCOSObject().setItem(COSName.FIELDS, fields);
                document.setAllSecurityToBeRemoved(true);
                document.save(snapshot.toFile());
            }
            result = PdfVerifiedCopy.create(context, snapshot, null, "Parent.pdf", CHECKED_AT, outputDir(context));
            assertEquals(PdfVerifiedCopy.Outcome.CREATED, result.outcome);
            try (PDDocument copy = PDDocument.load(result.path.toFile())) {
                assertFalse(copy.isEncrypted());
                assertTrue(copy.getSignatureFields().isEmpty());
                assertEquals(1, copy.getPage(0).getAnnotations().size());
                assertEquals("Keep this field", copy.getPage(0).getAnnotations().get(0).getCOSObject().getString(COSName.T));
                COSStream untouched = copy.getPage(0).getAnnotations().get(0).getNormalAppearanceStream().getCOSObject();
                assertTrue(content(xobject(xobject(untouched, "FRM"), "n1")).contains("DSUnknown"));
                assertTrue(content(xobject(xobject(untouched, "FRM"), "n4")).contains("Signature Not Verified"));
                assertEquals("Keep this value", copy.getDocumentCatalog().getAcroForm()
                        .getField("Keep this field").getValueAsString());
                assertTrue(new PDFTextStripper().getText(copy).contains("Signature valid"));
            }
        } finally {
            deleteCopy(result);
            Files.deleteIfExists(snapshot);
            Files.deleteIfExists(fixture);
        }
    }

    private static Context context() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        PDFBoxResourceLoader.init(context);
        return context;
    }

    private static Path outputDir(Context context) {
        return context.getCacheDir().toPath().resolve(PdfVerifiedCopy.CACHE_DIRECTORY);
    }

    private static Path fixture(Context context, String name) throws Exception {
        Path copy = Files.createTempFile(context.getCacheDir().toPath(), "verified-copy-test-", ".pdf");
        try (InputStream input = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open(name)) {
            Files.copy(input, copy, StandardCopyOption.REPLACE_EXISTING);
        }
        return copy;
    }

    private static PdfSignatureVerifier fixtureVerifier(Context context) throws Exception {
        X509Certificate root;
        try (InputStream input = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("test-root.der")) {
            root = (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(input);
        }
        Clock clock = Clock.fixed(Instant.parse("2027-01-01T00:00:00Z"), ZoneOffset.UTC);
        return new PdfSignatureVerifier(context, clock, (leaf, chain, now) ->
                PdfSignatureVerifier.evaluateTrust(leaf, chain, now, List.of(root), false));
    }

    private static byte[] hash(Path file) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(file));
    }

    private static COSStream xobject(COSDictionary form, String name) {
        COSDictionary resources = form.getCOSDictionary(COSName.RESOURCES);
        COSDictionary objects = resources == null ? null : resources.getCOSDictionary(COSName.XOBJECT);
        return objects == null ? null : (COSStream) objects.getDictionaryObject(COSName.getPDFName(name));
    }

    private static String content(COSStream stream) throws Exception {
        try (InputStream input = stream.createInputStream()) {
            return new String(input.readAllBytes(), StandardCharsets.ISO_8859_1);
        }
    }

    private static void deleteCopy(PdfVerifiedCopy.Result result) throws Exception {
        if (result != null && result.path != null) {
            Files.deleteIfExists(result.path);
            Files.deleteIfExists(result.path.getParent());
        }
    }
}
