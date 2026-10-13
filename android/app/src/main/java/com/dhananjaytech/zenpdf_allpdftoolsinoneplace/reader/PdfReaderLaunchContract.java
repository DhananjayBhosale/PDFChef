package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Pure allowlist for launching and receiving results from the private reader Activity. */
public final class PdfReaderLaunchContract {
    public static final String EXTRA_REF = "pdfchef.reader.ref";
    public static final String EXTRA_DISPLAY_NAME = "pdfchef.reader.displayName";
    public static final String EXTRA_INITIAL_ACTION = "pdfchef.reader.initialAction";
    public static final String EXTRA_ACTION = "pdfchef.reader.action";
    public static final String EXTRA_TOOL_PATH = "pdfchef.reader.toolPath";
    public static final String INITIAL_ACTION_VERIFY_SIGNATURES = "verify-signatures";
    public static final String ACTION_CLOSED = "closed";
    public static final String ACTION_TOOL = "tool";
    public static final String ACTIVITY_CLASS_NAME =
            "com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader.PdfReaderActivity";

    private static final Pattern LEGACY_REF = Pattern.compile("a1_([1-9][0-9]{0,15})");
    private static final Pattern OWNED_REF = Pattern.compile("d1_[A-Za-z0-9_-]{22,64}");
    private static final Set<String> TOOL_PATHS;

    static {
        LinkedHashSet<String> paths = new LinkedHashSet<>();
        Collections.addAll(paths,
                "/compress", "/merge", "/split", "/edit", "/make-fillable", "/sign",
                "/watermark", "/protect", "/unlock", "/delete-pages", "/page-numbers",
                "/reorder", "/rotate", "/flatten", "/extract", "/pdf-to-jpg",
                "/pdf-to-word", "/ocr", "/metadata", "/repair", "/compare");
        TOOL_PATHS = Collections.unmodifiableSet(paths);
    }

    private PdfReaderLaunchContract() { }

    public static Intent createIntent(Context context, String ref, String displayName)
            throws Failure {
        if (context == null || !isCanonicalRef(ref) || !isSafeDisplayName(displayName)) {
            throw invalid();
        }
        Intent intent = new Intent();
        intent.setComponent(new ComponentName(context.getPackageName(), ACTIVITY_CLASS_NAME));
        intent.putExtra(EXTRA_REF, ref);
        intent.putExtra(EXTRA_DISPLAY_NAME, displayName);
        return intent;
    }

    public static Intent createSignatureVerificationIntent(
            Context context, String ref, String displayName) throws Failure {
        Intent intent = createIntent(context, ref, displayName);
        intent.putExtra(EXTRA_INITIAL_ACTION, INITIAL_ACTION_VERIFY_SIGNATURES);
        return intent;
    }

    /** Accept only the ordinary reader request or the one allowlisted initial action. */
    public static boolean requestsSignatureVerification(Intent intent) throws Failure {
        if (intent == null || intent.getExtras() == null) throw invalid();
        Bundle extras = intent.getExtras();
        return requestsSignatureVerification(extras.keySet(), extras.get(EXTRA_INITIAL_ACTION));
    }

    static boolean requestsSignatureVerification(Set<String> keys, Object action) throws Failure {
        if (keys == null) throw invalid();
        Set<String> ordinary = Set.of(EXTRA_REF, EXTRA_DISPLAY_NAME);
        if (keys.equals(ordinary)) {
            if (action != null) throw invalid();
            return false;
        }
        if (!keys.equals(Set.of(EXTRA_REF, EXTRA_DISPLAY_NAME, EXTRA_INITIAL_ACTION))) {
            throw invalid();
        }
        if (!INITIAL_ACTION_VERIFY_SIGNATURES.equals(action)) throw invalid();
        return true;
    }

    public static Intent closedResultIntent() {
        Intent result = new Intent();
        result.putExtra(EXTRA_ACTION, ACTION_CLOSED);
        return result;
    }

    public static Intent toolResultIntent(String toolPath) throws Failure {
        if (!TOOL_PATHS.contains(toolPath)) throw invalid();
        Intent result = new Intent();
        result.putExtra(EXTRA_ACTION, ACTION_TOOL);
        result.putExtra(EXTRA_TOOL_PATH, toolPath);
        return result;
    }

    public static Result parseResult(int resultCode, Intent data) throws Failure {
        if (resultCode != Activity.RESULT_OK || data == null || data.getAction() != null
                || data.getData() != null || data.getType() != null || data.getClipData() != null
                || data.getCategories() != null || data.getComponent() != null
                || data.getPackage() != null || data.getFlags() != 0) throw invalid();
        Bundle extras = data.getExtras();
        if (extras == null) throw invalid();
        Set<String> keys = extras.keySet();
        Object rawAction = extras.get(EXTRA_ACTION);
        if (!(rawAction instanceof String action)) throw invalid();
        if (ACTION_CLOSED.equals(action)) {
            if (!keys.equals(Set.of(EXTRA_ACTION))) throw invalid();
            return new Result(ACTION_CLOSED, null);
        }
        Object rawPath = extras.get(EXTRA_TOOL_PATH);
        if (!ACTION_TOOL.equals(action) || !keys.equals(Set.of(EXTRA_ACTION, EXTRA_TOOL_PATH))
                || !(rawPath instanceof String toolPath) || !TOOL_PATHS.contains(toolPath)) {
            throw invalid();
        }
        return new Result(ACTION_TOOL, toolPath);
    }

    public static boolean isCanonicalRef(String value) {
        if (value == null) return false;
        if (OWNED_REF.matcher(value).matches()) return true;
        Matcher legacy = LEGACY_REF.matcher(value);
        if (!legacy.matches()) return false;
        try {
            long id = Long.parseLong(legacy.group(1));
            return id >= 1 && id <= 9_007_199_254_740_991L && value.equals("a1_" + id);
        } catch (NumberFormatException failure) {
            return false;
        }
    }

    public static boolean isSafeDisplayName(String value) {
        if (value == null || value.isBlank() || value.length() > 180
                || value.indexOf('\0') >= 0 || value.indexOf('/') >= 0
                || value.indexOf('\\') >= 0 || ".".equals(value) || "..".equals(value)
                || value.getBytes(StandardCharsets.UTF_8).length > 720) return false;
        for (int index = 0; index < value.length(); index++) {
            char unit = value.charAt(index);
            if (Character.isHighSurrogate(unit)) {
                if (++index >= value.length() || !Character.isLowSurrogate(value.charAt(index))) {
                    return false;
                }
            } else if (Character.isLowSurrogate(unit)) return false;
        }
        return true;
    }

    public static Set<String> toolPaths() { return TOOL_PATHS; }

    public static final class Result {
        private final String action;
        private final String toolPath;
        Result(String action, String toolPath) {
            this.action = Objects.requireNonNull(action);
            this.toolPath = toolPath;
        }
        public String action() { return action; }
        public String toolPath() { return toolPath; }
    }

    public static final class Failure extends Exception {
        private Failure() { super("The reader result is invalid."); }
    }

    private static Failure invalid() { return new Failure(); }
}
