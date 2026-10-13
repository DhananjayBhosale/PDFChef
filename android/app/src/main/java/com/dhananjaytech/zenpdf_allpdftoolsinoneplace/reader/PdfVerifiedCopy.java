package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import android.content.Context;
import android.graphics.RectF;

import androidx.annotation.Nullable;

import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;
import com.tom_roush.pdfbox.cos.COSArray;
import com.tom_roush.pdfbox.cos.COSBase;
import com.tom_roush.pdfbox.cos.COSDictionary;
import com.tom_roush.pdfbox.cos.COSName;
import com.tom_roush.pdfbox.cos.COSStream;
import com.tom_roush.pdfbox.io.MemoryUsageSetting;
import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.pdmodel.PDDocumentInformation;
import com.tom_roush.pdfbox.pdmodel.PDPage;
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream;
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle;
import com.tom_roush.pdfbox.pdmodel.interactive.digitalsignature.PDSignature;
import com.tom_roush.pdfbox.pdmodel.encryption.AccessPermission;
import com.tom_roush.pdfbox.pdmodel.encryption.StandardProtectionPolicy;
import com.tom_roush.pdfbox.pdmodel.graphics.form.PDFormXObject;
import com.tom_roush.pdfbox.util.Matrix;

import java.io.ByteArrayOutputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.text.SimpleDateFormat;
import java.util.Collections;
import java.util.Date;
import java.util.IdentityHashMap;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/** Creates a disposable visual copy. Caller must first fully verify the immutable snapshot. */
final class PdfVerifiedCopy {
    static final String CACHE_DIRECTORY = "pdfchef_verified_copies";
    static final long MAX_SOURCE_BYTES = 128L * 1024 * 1024;
    private static final long MAX_OUTPUT_BYTES = 256L * 1024 * 1024;
    private static final long STALE_MILLIS = 24L * 60 * 60 * 1000;
    private static final int MAX_NODES = 100_000;
    private static final String VALID_LAYER =
            "% DSValid\nq 0.13 0.62 0.29 rg 14 52 m 40 22 l 88 80 l 78 88 l 40 42 l 24 62 h f Q\n";

    enum Outcome { CREATED, NO_SIGNATURE_BOX, UNSUPPORTED_SIGNATURE_BOX, PASSWORD_UNSUPPORTED }

    static final class Result {
        final Outcome outcome;
        @Nullable final Path path;
        final int pageCount;
        final boolean encrypted;

        private Result(Outcome outcome, @Nullable Path path, int pageCount, boolean encrypted) {
            this.outcome = outcome;
            this.path = path;
            this.pageCount = pageCount;
            this.encrypted = encrypted;
        }
    }

    private PdfVerifiedCopy() {}

    static Result create(Context context, Path snapshot, @Nullable char[] password,
            String displayName, Date checkedAt, Path outputDir) throws IOException {
        requirePrivateSnapshot(context, snapshot);
        Path root = prepareOutputDirectory(context, outputDir);
        if (snapshot.toRealPath().startsWith(root)) throw new IOException("Source cannot be in output directory");
        deleteStaleCopies(root);
        PDFBoxResourceLoader.init(context.getApplicationContext());
        try (PDDocument document = PDDocument.load(snapshot.toFile(),
                password == null ? "" : new String(password), memory())) {
            boolean encrypted = document.isEncrypted();
            if (encrypted && !canPreservePassword(password)) {
                return new Result(Outcome.PASSWORD_UNSUPPORTED, null, 0, true);
            }
            Outcome outcome = markDocument(document, checkedAt);
            if (outcome != Outcome.CREATED) return new Result(outcome, null, 0, encrypted);
            if (encrypted) {
                StandardProtectionPolicy policy = new StandardProtectionPolicy(
                        UUID.randomUUID().toString(), password == null ? "" : new String(password),
                        new AccessPermission());
                policy.setEncryptionKeyLength(128);
                policy.setPreferAES(true);
                document.protect(policy);
            } else {
                document.setAllSecurityToBeRemoved(true);
            }
            Path directory = Files.createTempDirectory(root, "copy-");
            Path output = directory.resolve(copyName(displayName));
            boolean saved = false;
            try {
                try (OutputStream sink = boundedOutput(Files.newOutputStream(output,
                        StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE))) {
                    document.save(sink);
                }
                if (encrypted) {
                    try (PDDocument reopened = PDDocument.load(output.toFile(),
                            password == null ? "" : new String(password), memory())) {
                        if (!reopened.isEncrypted()) throw new IOException("Copy lost password protection");
                    }
                }
                checkInterrupted();
                saved = true;
                return new Result(Outcome.CREATED, output, document.getNumberOfPages(), encrypted);
            } finally {
                if (!saved) {
                    Files.deleteIfExists(output);
                    Files.deleteIfExists(directory);
                }
            }
        }
    }

    /** Preflights printing without creating any cache copy, including for unsupported share passwords. */
    static Result prepareForPrint(Context context, Path snapshot, @Nullable char[] password) throws IOException {
        requirePrivateSnapshot(context, snapshot);
        PDFBoxResourceLoader.init(context.getApplicationContext());
        try (PDDocument document = PDDocument.load(snapshot.toFile(),
                password == null ? "" : new String(password), memory())) {
            Outcome outcome = preflight(document, signatureDictionaries(document));
            return new Result(outcome, outcome == Outcome.CREATED ? snapshot : null,
                    document.getNumberOfPages(), document.isEncrypted());
        }
    }

    /** The only decrypted output goes directly to the system print spooler. */
    static void writeForPrint(Path snapshot, @Nullable char[] password, Date checkedAt,
            OutputStream output) throws IOException {
        try (PDDocument document = PDDocument.load(snapshot.toFile(),
                password == null ? "" : new String(password), memory())) {
            if (markDocument(document, checkedAt) != Outcome.CREATED) throw new IOException("Signature box unavailable");
            document.setAllSecurityToBeRemoved(true);
            document.save(output);
        }
    }

    static boolean canPreservePassword(@Nullable char[] password) {
        if (password == null) return true;
        if (password.length > 32) return false;
        for (char value : password) if (value > 0x7f) return false;
        return true;
    }

    private static Set<COSDictionary> signatureDictionaries(PDDocument document) throws IOException {
        Set<COSDictionary> signatures = Collections.newSetFromMap(new IdentityHashMap<>());
        for (PDSignature signature : document.getSignatureDictionaries()) signatures.add(signature.getCOSObject());
        return signatures;
    }

    @Nullable private static COSDictionary signatureValue(COSDictionary field) throws IOException {
        for (int depth = 0; field != null; depth++) {
            if (depth > 64) throw new IOException("PDF field depth exceeded");
            if (field.containsKey(COSName.V)) return dictionary(field, COSName.V);
            field = dictionary(field, COSName.PARENT);
        }
        return null;
    }

    private static boolean signedField(COSDictionary field, Set<COSDictionary> signatures) throws IOException {
        return COSName.SIG.equals(fieldType(field)) && signatures.contains(signatureValue(field));
    }

    @Nullable private static PDRectangle visibleRect(COSDictionary widget) {
        COSArray rect = widget.getCOSArray(COSName.RECT);
        COSDictionary ap = dictionary(widget, COSName.AP);
        if (rect == null || rect.size() != 4 || ap == null || ap.getDictionaryObject(COSName.N) == null) return null;
        // Hidden (2) and NoView (32) boxes are never drawn, so they must not gain a check mark.
        if ((widget.getInt(COSName.F, 0) & (2 | 32)) != 0) return null;
        PDRectangle bounds = new PDRectangle(rect);
        return positive(bounds.getWidth()) && positive(bounds.getHeight()) ? bounds : null;
    }

    private static Outcome preflight(PDDocument document, Set<COSDictionary> signatures) throws IOException {
        if (document.getNumberOfPages() > 10_000) throw new IOException("PDF limit exceeded");
        int nodes = 0, visible = 0;
        for (PDPage page : document.getPages()) {
            checkInterrupted();
            COSArray annots = page.getCOSObject().getCOSArray(COSName.ANNOTS);
            if (annots == null) continue;
            for (int i = 0; i < annots.size(); i++) {
                if (++nodes > MAX_NODES) throw new IOException("PDF limit exceeded");
                COSBase item = annots.getObject(i);
                if (!(item instanceof COSDictionary)) continue;
                COSDictionary widget = (COSDictionary) item;
                if (!COSName.WIDGET.equals(widget.getCOSName(COSName.SUBTYPE)) || !signedField(widget, signatures)) continue;
                PDRectangle rect = visibleRect(widget);
                if (rect == null) continue;
                COSStream normal = stream(dictionary(widget, COSName.AP), COSName.N);
                COSDictionary layers = xObjects(stream(xObjects(normal), COSName.getPDFName("FRM")));
                if (stream(layers, COSName.getPDFName("n1")) == null) return Outcome.UNSUPPORTED_SIGNATURE_BOX;
                COSName n4 = COSName.getPDFName("n4");
                if (layers.containsKey(n4)) {
                    COSStream status = stream(layers, n4);
                    if (status == null) return Outcome.UNSUPPORTED_SIGNATURE_BOX;
                    String before = readLayer(status);
                    if (before.equals(validStatusText(before))) return Outcome.UNSUPPORTED_SIGNATURE_BOX;
                }
                try {
                    appearanceTransform(normal, rect);
                } catch (IOException invalid) {
                    return Outcome.UNSUPPORTED_SIGNATURE_BOX;
                }
                if (++visible > 64) throw new IOException("PDF limit exceeded");
            }
        }
        return visible == 0 ? Outcome.NO_SIGNATURE_BOX : Outcome.CREATED;
    }

    private static Outcome markDocument(PDDocument document, Date checkedAt) throws IOException {
        Set<COSDictionary> signatures = signatureDictionaries(document);
        Outcome outcome = preflight(document, signatures);
        if (outcome != Outcome.CREATED) return outcome;
        for (PDPage page : document.getPages()) {
            checkInterrupted();
            COSArray annots = page.getCOSObject().getCOSArray(COSName.ANNOTS);
            if (annots == null) continue;
            boolean wrapped = false;
            for (int i = 0; i < annots.size(); i++) {
                COSBase item = annots.getObject(i);
                if (!(item instanceof COSDictionary)) continue;
                COSDictionary widget = (COSDictionary) item;
                if (!COSName.WIDGET.equals(widget.getCOSName(COSName.SUBTYPE)) || !signedField(widget, signatures)) continue;
                PDRectangle rect = visibleRect(widget);
                if (rect != null) {
                    COSStream normal = stream(dictionary(widget, COSName.AP), COSName.N);
                    COSStream frm = stream(xObjects(normal), COSName.getPDFName("FRM"));
                    flattenWidget(document, page, markedAppearance(document, normal, frm, xObjects(frm)), rect, !wrapped);
                    wrapped = true;
                }
                annots.remove(i--);
            }
        }
        COSDictionary acroForm = dictionary(document.getDocumentCatalog().getCOSObject(), COSName.ACRO_FORM);
        if (acroForm != null && !pruneFields(acroForm.getCOSArray(COSName.FIELDS), signatures, null, 0, new int[] {0})) {
            acroForm.removeItem(COSName.SIG_FLAGS);
        }
        // Invisible provenance remains in both shared and printed copies.
        PDDocumentInformation information = document.getDocumentInformation();
        information.setSubject(provenanceNote(checkedAt));
        information.setCreator("PDF Chef");
        return Outcome.CREATED;
    }

    private static COSStream markedAppearance(PDDocument document, COSStream normal,
            COSStream frm, COSDictionary layers) throws IOException {
        // Appearances/resources may be shared with an unmarked widget. Copy just the
        // changed branches so that drawing a tick cannot alter any other annotation.
        COSStream markedNormal = copyStream(document, normal, readLayer(normal));
        COSStream markedFrm = copyStream(document, frm, readLayer(frm));
        COSDictionary markedLayers = copyXObjects(markedFrm);
        COSName n1 = COSName.getPDFName("n1"), n3 = COSName.getPDFName("n3"), n4 = COSName.getPDFName("n4");
        markedLayers.setItem(n1, copyStream(document, stream(layers, n1), VALID_LAYER));
        if (stream(layers, n3) != null) {
            markedLayers.setItem(n3, copyStream(document, stream(layers, n3), "% DSBlank\n"));
        }
        COSStream status = stream(layers, n4);
        if (status != null) {
            String before = readLayer(status);
            String after = validStatusText(before);
            if (before.equals(after)) throw new IOException("Unreplaceable signature status");
            markedLayers.setItem(n4, copyStream(document, status, after));
        }
        copyXObjects(markedNormal).setItem(COSName.getPDFName("FRM"), markedFrm);
        return markedNormal;
    }

    private static COSStream copyStream(PDDocument document, COSStream original, String content) throws IOException {
        COSStream copy = document.getDocument().createCOSStream();
        copy.addAll(original);
        replaceStream(copy, content);
        return copy;
    }

    private static COSDictionary copyXObjects(COSStream form) {
        COSDictionary resources = new COSDictionary(dictionary(form, COSName.RESOURCES));
        COSDictionary objects = new COSDictionary(dictionary(resources, COSName.XOBJECT));
        resources.setItem(COSName.XOBJECT, objects);
        form.setItem(COSName.RESOURCES, resources);
        return objects;
    }

    // Do not use PDAcroForm.flatten: its missing-/P fallback selects unrelated widgets,
    // and it removes XFA. Draw only this widget's modified AP, including merged fields.
    private static void flattenWidget(PDDocument document, PDPage page, COSStream normal,
            PDRectangle rect, boolean resetContext) throws IOException {
        Matrix transform = appearanceTransform(normal, rect);
        try (PDPageContentStream content = new PDPageContentStream(document, page,
                PDPageContentStream.AppendMode.APPEND, true, resetContext)) {
            content.saveGraphicsState();
            content.transform(transform);
            content.drawForm(new PDFormXObject(normal));
            content.restoreGraphicsState();
        }
    }

    private static Matrix appearanceTransform(COSStream normal, PDRectangle rect) throws IOException {
        PDFormXObject appearance = new PDFormXObject(normal);
        PDRectangle bbox = appearance.getBBox();
        if (bbox == null) throw new IOException("Missing appearance bounds");
        RectF bounds = new RectF();
        bbox.transform(appearance.getMatrix()).computeBounds(bounds, true);
        if (!positive(bounds.width()) || !positive(bounds.height())) {
            throw new IOException("Invalid appearance bounds");
        }
        float sx = rect.getWidth() / bounds.width();
        float sy = rect.getHeight() / bounds.height();
        float tx = rect.getLowerLeftX() - sx * bounds.left;
        float ty = rect.getLowerLeftY() - sy * bounds.top;
        if (!Float.isFinite(sx) || !Float.isFinite(sy) || !Float.isFinite(tx) || !Float.isFinite(ty)) {
            throw new IOException("Invalid appearance transform");
        }
        return new Matrix(sx, 0, 0, sy, tx, ty);
    }

    /** Removes all checked signature fields, including invisible ones; preserves unsigned fields. */
    private static boolean pruneFields(@Nullable COSArray fields, Set<COSDictionary> signatures,
            @Nullable COSName inheritedType, int depth, int[] visited) throws IOException {
        if (fields == null) return false;
        if (depth > 64) throw new IOException("PDF field depth exceeded");
        boolean signatureRemains = false;
        for (int i = 0; i < fields.size(); i++) {
            checkInterrupted();
            if (++visited[0] > MAX_NODES) throw new IOException("PDF limit exceeded");
            COSBase item = fields.getObject(i);
            if (!(item instanceof COSDictionary)) continue;
            COSDictionary field = (COSDictionary) item;
            COSName type = field.getCOSName(COSName.FT);
            if (type == null) type = inheritedType;
            if (COSName.SIG.equals(type) && signatures.contains(signatureValue(field))) {
                fields.remove(i--);
                continue;
            }
            boolean childSignature = pruneFields(field.getCOSArray(COSName.KIDS), signatures, type, depth + 1, visited);
            signatureRemains |= COSName.SIG.equals(type) || childSignature;
        }
        return signatureRemains;
    }

    @Nullable private static COSName fieldType(COSDictionary field) throws IOException {
        for (int depth = 0; field != null; depth++) {
            if (depth > 64) throw new IOException("PDF field depth exceeded");
            COSName type = field.getCOSName(COSName.FT);
            if (type != null) return type;
            field = dictionary(field, COSName.PARENT);
        }
        return null;
    }

    @Nullable private static COSDictionary dictionary(@Nullable COSDictionary parent, COSName key) {
        COSBase value = parent == null ? null : parent.getDictionaryObject(key);
        return value instanceof COSDictionary ? (COSDictionary) value : null;
    }

    @Nullable private static COSStream stream(@Nullable COSDictionary parent, COSName key) {
        COSDictionary value = dictionary(parent, key);
        return value instanceof COSStream ? (COSStream) value : null;
    }

    @Nullable private static COSDictionary xObjects(@Nullable COSStream form) {
        return dictionary(dictionary(form, COSName.RESOURCES), COSName.XOBJECT);
    }

    private static boolean positive(float value) { return Float.isFinite(value) && value > 0; }

    private static void replaceStream(COSStream stream, String text) throws IOException {
        stream.removeItem(COSName.DECODE_PARMS);
        try (OutputStream output = stream.createOutputStream(COSName.FLATE_DECODE)) {
            output.write(text.getBytes(StandardCharsets.ISO_8859_1));
        }
    }

    private static String readLayer(COSStream stream) throws IOException {
        try (InputStream input = stream.createInputStream();
                ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) {
                checkInterrupted();
                if (bytes.size() + count > 1024 * 1024) throw new IOException("Appearance too large");
                bytes.write(buffer, 0, count);
            }
            return new String(bytes.toByteArray(), StandardCharsets.ISO_8859_1);
        }
    }

    /** Replaces only the first literal-string Tj operand, preserving all other PDF operators. */
    static String validStatusText(String text) {
        int btEnd = -1, stringStart = -1, stringEnd = -1;
        for (int i = 0; i < text.length();) {
            i = skipSpaceAndComments(text, i);
            if (i >= text.length()) break;
            char c = text.charAt(i);
            if (c == '(') {
                int start = i++, depth = 1;
                while (i < text.length() && depth > 0) {
                    char next = text.charAt(i++);
                    if (next == '\\' && i < text.length()) i++;
                    else if (next == '(') depth++;
                    else if (next == ')') depth--;
                }
                int op = skipSpaceAndComments(text, i);
                if (depth == 0 && stringStart < 0 && tokenAt(text, op, "Tj")) {
                    stringStart = start;
                    stringEnd = i;
                }
            } else if (c == '<' && i + 1 < text.length() && text.charAt(i + 1) != '<') {
                int end = text.indexOf('>', i + 1);
                i = end < 0 ? text.length() : end + 1;
            } else if (c == '/') {
                i++;
                while (i < text.length() && !delimiter(text.charAt(i))) i++;
            } else {
                if (btEnd < 0 && tokenAt(text, i, "BT")) btEnd = i + 2;
                int start = i++;
                if (!delimiter(text.charAt(start))) {
                    while (i < text.length() && !delimiter(text.charAt(i))) i++;
                }
            }
        }
        if (stringStart < 0 || btEnd < 0 || btEnd > stringStart) return text;
        return text.substring(0, btEnd) + "\n0.13 0.5 0.25 rg\n"
                + text.substring(btEnd, stringStart) + "(Signature valid)"
                + text.substring(stringEnd);
    }

    private static boolean tokenAt(String text, int offset, String token) {
        int end = offset + token.length();
        return text.startsWith(token, offset) && (end == text.length() || delimiter(text.charAt(end)));
    }

    private static boolean delimiter(char c) {
        return c == 0 || c == '\t' || c == '\n' || c == '\f' || c == '\r' || c == ' '
                || "()<>[]{}/%".indexOf(c) >= 0;
    }

    private static int skipSpaceAndComments(String text, int offset) {
        while (offset < text.length()) {
            char c = text.charAt(offset);
            if (c == '%') {
                while (offset < text.length() && text.charAt(offset) != '\n'
                        && text.charAt(offset) != '\r') offset++;
            } else if (c == 0 || c == '\t' || c == '\n' || c == '\f' || c == '\r' || c == ' ') {
                offset++;
            } else break;
        }
        return offset;
    }

    static String provenanceNote(Date checkedAt) {
        return "Copy of a digitally signed PDF. Its signature was checked by PDF Chef on "
                + new SimpleDateFormat("d MMM yyyy", Locale.US).format(checkedAt)
                + ". This copy itself is not digitally signed.";
    }

    static String copyName(String displayName) {
        String base = displayName.replaceAll("[\\p{Cntrl}/\\\\]", "_").trim();
        if (base.toLowerCase(Locale.ROOT).endsWith(".pdf")) base = base.substring(0, base.length() - 4);
        // Stay below filesystem component limits even for multibyte display names.
        while (base.getBytes(StandardCharsets.UTF_8).length > 180) {
            base = base.substring(0, base.offsetByCodePoints(base.length(), -1));
        }
        if (base.isEmpty() || base.equals(".") || base.equals("..")) base = "Document";
        return base + " (verified copy).pdf";
    }

    static MemoryUsageSetting memory() {
        return MemoryUsageSetting.setupMainMemoryOnly(96L * 1024 * 1024);
    }

    private static void requirePrivateSnapshot(Context context, Path snapshot) throws IOException {
        if (snapshot == null || Files.isSymbolicLink(snapshot)
                || !Files.isRegularFile(snapshot, LinkOption.NOFOLLOW_LINKS)
                || Files.size(snapshot) <= 0 || Files.size(snapshot) > MAX_SOURCE_BYTES) {
            throw new IOException("Unsafe PDF snapshot");
        }
        Path actual = snapshot.toRealPath();
        if (!actual.startsWith(context.getFilesDir().toPath().toRealPath())
                && !actual.startsWith(context.getCacheDir().toPath().toRealPath())) {
            throw new IOException("Snapshot must be private");
        }
    }

    private static Path prepareOutputDirectory(Context context, Path outputDir) throws IOException {
        Path cache = context.getCacheDir().toPath().toRealPath();
        Path normalized = outputDir.toAbsolutePath().normalize();
        // Dedicated direct child: cleanup can never reach the snapshot or unrelated cache data.
        if (normalized.getParent() == null || !normalized.getParent().toRealPath().equals(cache)
                || Files.isSymbolicLink(normalized)) throw new IOException("Unsafe output directory");
        Files.createDirectories(normalized);
        if (!Files.isDirectory(normalized, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Unsafe output directory");
        return normalized.toRealPath();
    }

    private static void deleteStaleCopies(Path root) throws IOException {
        long cutoff = System.currentTimeMillis() - STALE_MILLIS;
        int retained = 0;
        try (DirectoryStream<Path> entries = Files.newDirectoryStream(root, "copy-*")) {
            for (Path entry : entries) {
                checkInterrupted();
                if (Files.isSymbolicLink(entry) || !Files.isDirectory(entry, LinkOption.NOFOLLOW_LINKS)) continue;
                if (Files.getLastModifiedTime(entry, LinkOption.NOFOLLOW_LINKS).toMillis() < cutoff) {
                    try (DirectoryStream<Path> files = Files.newDirectoryStream(entry)) {
                        for (Path file : files) {
                            if (Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) Files.delete(file);
                        }
                    }
                    Files.delete(entry);
                } else if (++retained >= 32) throw new IOException("Too many recent copies");
            }
        }
    }

    static OutputStream boundedOutput(OutputStream output) {
        return new FilterOutputStream(output) {
            private long count;
            @Override public void write(int value) throws IOException {
                checkLimit(1);
                out.write(value);
            }
            @Override public void write(byte[] bytes, int offset, int length) throws IOException {
                checkLimit(length);
                out.write(bytes, offset, length);
            }
            private void checkLimit(int length) throws IOException {
                checkInterrupted();
                if (length > MAX_OUTPUT_BYTES - count) throw new IOException("Copy too large");
                count += length;
            }
        };
    }

    private static void checkInterrupted() throws IOException {
        if (Thread.currentThread().isInterrupted()) throw new IOException("Copy interrupted");
    }
}
