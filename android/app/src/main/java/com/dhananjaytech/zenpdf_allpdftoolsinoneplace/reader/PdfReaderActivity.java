package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import android.annotation.SuppressLint;
import android.app.Dialog;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.print.PrintManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.RectF;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.SparseArray;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.ImageButton;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.fragment.app.DialogFragment;
import androidx.fragment.app.Fragment;
import androidx.fragment.app.FragmentManager;
import androidx.lifecycle.Lifecycle;
import androidx.pdf.ExperimentalPdfApi;
import androidx.pdf.PdfDocument;
import androidx.pdf.view.PdfView;
import androidx.pdf.viewer.fragment.PdfViewerFragment;

import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.BuildConfig;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.PdfChefApplication;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.R;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.DocumentLifecycleCoordinator;

import java.nio.file.Path;
import java.util.Arrays;
import java.util.Date;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;

/**
 * The reader.
 *
 * It is handed one opaque ref and one safe display name and nothing else, and it
 * gives back one of two answers: the person closed it, or the person chose a
 * tool. No URI, path, provider address, byte, password or exception detail ever
 * leaves this class, and none of them is ever shown.
 *
 * The closed answer is installed as the result before anything else can go
 * wrong, so a finish the framework causes still reads as "closed" rather than
 * as a cancelled launch. The document is prepared off the main thread as a
 * private session, and that session is handed to the next instance across a
 * rotation instead of being re-staged from scratch.
 */
public final class PdfReaderActivity extends AppCompatActivity {

    private static final String FRAGMENT_TAG = "pdfchef.reader.fragment";
    private static final String STATE_PAGE = "pdfchef.reader.page";
    private static final String STATE_SEARCH = "pdfchef.reader.search";
    private static final String STATE_FAILED = "pdfchef.reader.failed";
    private static final String STATE_SIGNATURE_PRESENTED = "pdfchef.reader.signaturePresented";
    private static final long MESSAGE_VISIBLE_MS = 6000L;

    /** Path plus the exact tool name used everywhere else in the product. */
    private static final String[][] TOOLS = {
            {"/compress", "Compress PDF"},
            {"/merge", "Merge PDF"},
            {"/split", "Split PDF"},
            {"/edit", "Edit PDF"},
            {"/make-fillable", "Make Fillable"},
            {"/sign", "Sign PDF"},
            {"/watermark", "Watermark PDF"},
            {"/protect", "Protect PDF"},
            {"/unlock", "Unlock PDF"},
            {"/delete-pages", "Delete Pages"},
            {"/page-numbers", "Page Numbers"},
            {"/reorder", "Reorder Pages"},
            {"/rotate", "Rotate Pages"},
            {"/flatten", "Flatten PDF"},
            {"/extract", "Extract Pages"},
            {"/pdf-to-jpg", "PDF to Image"},
            {"/pdf-to-word", "PDF to Word"},
            {"/ocr", "Extract Text"},
            {"/metadata", "Metadata"},
            {"/repair", "Repair PDF"},
            {"/compare", "Compare Summary"},
    };

    /** The one live session, carried across a configuration change rather than re-staged. */
    private static final class RetainedSession {
        private final PdfReaderDocumentSession session;
        private char[] password;

        RetainedSession(PdfReaderDocumentSession session, char[] password) {
            this.session = session;
            this.password = password;
        }

        char[] takePassword() {
            char[] value = password;
            password = null;
            return value;
        }
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    // A method reference, because a lambda body reading messageView here would be
    // an illegal forward reference to a field declared further down.
    private final Runnable hideMessage = this::hideMessageBanner;

    private ExecutorService executor;
    private DocumentLifecycleCoordinator coordinator;
    private PdfReaderActions actions;
    private PdfReaderDocumentSession session;
    private PdfView pdfView;

    private String ref;
    private String displayName;

    private View topBar;
    private View contentContainer;
    private View loadingView;
    private View errorView;
    private TextView titleView;
    private TextView pageView;
    private TextView messageView;
    private ImageButton searchButton;
    private ImageButton shareButton;
    private ImageButton saveButton;
    private ImageButton toolsButton;

    private Dialog toolsDialog;
    private AlertDialog searchDialog;
    private AlertDialog signatureDialog;
    private AlertDialog passwordDialog;
    private boolean passwordPromptPending;
    private boolean viewerNeedsAttach;
    private EditText searchInput;
    private TextView searchStatus;
    private Button searchPreviousButton;
    private Button searchNextButton;
    private Future<?> searchTask;
    private int searchGeneration;
    private int[] searchPages = new int[0];
    private int searchResultIndex;
    private boolean sharePending;
    private boolean savePending;
    private boolean signaturePending;
    private boolean verifySignaturesOnLoad;
    private boolean signatureVerificationPresented;
    private char[] documentPassword;
    private char[] verifiedCopyPassword;
    private char[] pendingDocumentPassword;
    private boolean retainedPasswordAttempted;
    private boolean resultSent;
    private boolean preparing;
    /** A prepare or a load already failed, so a rotation must not silently re-copy. */
    private boolean failed;
    private boolean searchActive;
    /**
     * The 1-based page a restore still owes, or 0 when the viewport is the truth.
     *
     * The viewer reports load success before it hands the document to its own
     * view, so a page-one viewport report arrives after the restore is issued.
     * The target is therefore held until the viewport actually reaches it, not
     * merely until the scroll has been asked for.
     */
    private int pendingPageTarget;
    private boolean pendingRestoreIssued;
    private int pageCount;
    private int currentPage = 1;
    private int bottomInset;

    private boolean basePaddingCaptured;
    private int barLeft;
    private int barTop;
    private int barRight;
    private int contentBottom;
    private int errorLeft;
    private int errorRight;
    private int errorBottom;
    private int messageBottom;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        setTheme(R.style.PdfReaderTheme);
        // We restore only the small state below and always build a fresh viewer. Restoring the
        // old fragment/view hierarchy first wastes Binder space and can restore a stale URI.
        super.onCreate(null);

        Intent intent = getIntent();
        String requestedRef = intent == null ? null : intent.getStringExtra(PdfReaderLaunchContract.EXTRA_REF);
        String requestedName = intent == null
                ? null : intent.getStringExtra(PdfReaderLaunchContract.EXTRA_DISPLAY_NAME);
        try {
            verifySignaturesOnLoad = PdfReaderLaunchContract.requestsSignatureVerification(intent);
        } catch (PdfReaderLaunchContract.Failure invalidRequest) {
            finishClosed();
            return;
        }
        if (!PdfReaderLaunchContract.isCanonicalRef(requestedRef)
                || !PdfReaderLaunchContract.isSafeDisplayName(requestedName)) {
            // Fail closed. Nothing is said about why, because nothing about the
            // request is the person's business or the caller's to learn.
            finishClosed();
            return;
        }
        ref = requestedRef;
        displayName = requestedName;

        // The default answer, installed before anything can go wrong. A finish
        // the framework causes is still a close, never a cancelled launch. Only
        // an allowlisted tool choice overwrites it.
        setResult(RESULT_OK, PdfReaderLaunchContract.closedResultIntent());

        if (savedInstanceState != null) {
            currentPage = Math.max(savedInstanceState.getInt(STATE_PAGE, 1), 1);
            searchActive = savedInstanceState.getBoolean(STATE_SEARCH, false);
            failed = savedInstanceState.getBoolean(STATE_FAILED, false);
            signatureVerificationPresented = savedInstanceState.getBoolean(
                    STATE_SIGNATURE_PRESENTED, false);
        }

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        setContentView(R.layout.pdf_reader_activity);
        bindViews();
        applyInsets();
        applyBarAppearance();

        coordinator = ((PdfChefApplication) getApplicationContext()).getDocumentLifecycleCoordinator();
        actions = new PdfReaderActions(this, coordinator);
        executor = Executors.newSingleThreadExecutor();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                // Back belongs to search first. Leaving the reader is the second press.
                if (isSearchActive()) {
                    setSearchActive(false);
                    return;
                }
                finishClosed();
            }
        });

        // The fragment is always fresh: the viewer will not reload a URI it has
        // already seen, so a restored one could never be pointed anywhere.
        Fragment restored = getSupportFragmentManager().findFragmentByTag(FRAGMENT_TAG);
        if (restored != null) {
            getSupportFragmentManager().beginTransaction().remove(restored).commitNowAllowingStateLoss();
        }

        Object carried = getLastCustomNonConfigurationInstance();
        if (carried instanceof RetainedSession) {
            RetainedSession retained = (RetainedSession) carried;
            session = retained.session;
            documentPassword = retained.takePassword();
        }

        if (session != null) {
            attachViewer(session);
        } else if (failed) {
            // This document already failed once. Rotating is not a retry, so the
            // error stays put and Retry remains the only thing that re-stages it.
            showError();
        } else {
            // A rotation that interrupted preparation gets one more attempt, and
            // the page it was already on is kept for that attempt.
            prepareDocument();
        }
    }

    private void bindViews() {
        topBar = findViewById(R.id.pdf_reader_top_bar);
        contentContainer = findViewById(R.id.pdf_reader_container);
        loadingView = findViewById(R.id.pdf_reader_loading);
        errorView = findViewById(R.id.pdf_reader_error);
        titleView = findViewById(R.id.pdf_reader_title);
        pageView = findViewById(R.id.pdf_reader_page);
        messageView = findViewById(R.id.pdf_reader_message);
        searchButton = findViewById(R.id.pdf_reader_search);
        shareButton = findViewById(R.id.pdf_reader_share);
        saveButton = findViewById(R.id.pdf_reader_save);
        toolsButton = findViewById(R.id.pdf_reader_tools);

        titleView.setText(displayName);
        findViewById(R.id.pdf_reader_back).setOnClickListener(view -> {
            if (isSearchActive()) {
                setSearchActive(false);
                return;
            }
            finishClosed();
        });
        searchButton.setOnClickListener(view -> setSearchActive(!isSearchActive()));
        shareButton.setOnClickListener(view -> share());
        saveButton.setOnClickListener(view -> save());
        toolsButton.setOnClickListener(view -> showTools());
        findViewById(R.id.pdf_reader_retry).setOnClickListener(view -> retry());
        findViewById(R.id.pdf_reader_close).setOnClickListener(view -> finishClosed());
        setActionsEnabled(false);
        updatePageLabel();
    }

    /**
     * System bars are added to the padding the layout already asked for, so the
     * top bar keeps its 4dp sides and the error screen its 24dp ones. Only the
     * bar and cutout insets are removed before dispatch: the keyboard inset is
     * passed through untouched so the viewer's own search field can resize.
     */
    private void applyInsets() {
        View root = findViewById(R.id.pdf_reader_root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, windowInsets) -> {
            if (!basePaddingCaptured) {
                barLeft = topBar.getPaddingLeft();
                barTop = topBar.getPaddingTop();
                barRight = topBar.getPaddingRight();
                contentBottom = contentContainer.getPaddingBottom();
                errorLeft = errorView.getPaddingLeft();
                errorRight = errorView.getPaddingRight();
                errorBottom = errorView.getPaddingBottom();
                messageBottom = messageView.getPaddingBottom();
                basePaddingCaptured = true;
            }

            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            bottomInset = bars.bottom;

            topBar.setPadding(barLeft + bars.left, barTop + bars.top, barRight + bars.right,
                    topBar.getPaddingBottom());
            contentContainer.setPadding(bars.left, 0, bars.right, contentBottom + bars.bottom);
            errorView.setPadding(errorLeft + bars.left, 0, errorRight + bars.right, errorBottom + bars.bottom);
            messageView.setPadding(messageView.getPaddingLeft(), messageView.getPaddingTop(),
                    messageView.getPaddingRight(), messageBottom + bars.bottom);

            return new WindowInsetsCompat.Builder(windowInsets)
                    .setInsets(
                            WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(),
                            Insets.NONE)
                    .build();
        });
    }

    /** Status and navigation icons follow the theme the reader is actually drawn in. */
    private void applyBarAppearance() {
        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(!night);
        controller.setAppearanceLightNavigationBars(!night);
    }

    /* ------------------------------------------------------------ document -- */

    private void prepareDocument() {
        if (preparing) return;
        preparing = true;
        failed = false;
        showLoading();
        final String requestedRef = ref;
        final String requestedName = displayName;
        executor.execute(() -> {
            PdfReaderDocumentSession staged = null;
            try {
                staged = coordinator.prepareReader(requestedRef, requestedName);
            } catch (Throwable ignored) {
                // The reason stays here. The screen says only what the person can act on.
            }
            final PdfReaderDocumentSession result = staged;
            main.post(() -> {
                preparing = false;
                if (isFinishing() || isDestroyed()) {
                    if (result != null) result.close();
                    return;
                }
                if (result == null) {
                    showError();
                    return;
                }
                attachViewer(result);
            });
        });
    }

    private void attachViewer(@NonNull PdfReaderDocumentSession staged) {
        if (session != null && session != staged) session.close();
        session = staged;
        if (!canShowReaderUi()) {
            viewerNeedsAttach = true;
            return;
        }
        viewerNeedsAttach = false;
        pageCount = 0;
        pdfView = null;
        // A fresh viewer starts at page one and says so before the saved page can
        // be reached. Until it is, those reports must not overwrite it.
        pendingPageTarget = currentPage > 1 ? currentPage : 0;
        pendingRestoreIssued = false;
        updatePageLabel();

        ReaderFragment fragment = new ReaderFragment();
        getSupportFragmentManager()
                .beginTransaction()
                .replace(R.id.pdf_reader_container, fragment, FRAGMENT_TAG)
                .commitNowAllowingStateLoss();
        fragment.setDocumentUri(staged.documentUri());
    }

    private void removeViewer() {
        // Detach the callback target first: SDK layout/viewport callbacks during teardown must
        // not change the page we are about to save or mark a replacement document as loaded.
        pdfView = null;
        Fragment current = getSupportFragmentManager().findFragmentByTag(FRAGMENT_TAG);
        if (current != null) {
            getSupportFragmentManager().beginTransaction().remove(current).commitNowAllowingStateLoss();
        }
    }

    private void closeSession() {
        if (session != null) {
            session.close();
            session = null;
        }
    }

    private void retry() {
        removeViewer();
        closeSession();
        clearPasswords();
        prepareDocument();
    }

    void onDocumentLoaded(@NonNull PdfView view, int pages) {
        if (view != pdfView) return;
        if (pendingDocumentPassword != null) {
            clearPassword(documentPassword);
            documentPassword = pendingDocumentPassword;
            pendingDocumentPassword = null;
            retainedPasswordAttempted = false;
        }
        pageCount = Math.max(pages, 0);
        if (currentPage < 1) currentPage = 1;
        showViewer();
        updatePageLabel();
        // The page the person was on, and the search they had open, survive the
        // rotation that rebuilt this fragment.
        schedulePendingPageRestore();
        if (searchActive) setSearchActive(true);
        hideToolbox();
        if (verifySignaturesOnLoad && !signatureVerificationPresented) {
            main.post(this::verifyDigitalSignatures);
        }
    }

    void onDocumentFailed() {
        // A snapshot that could not be read is not worth keeping staged.
        clearPassword(pendingDocumentPassword);
        pendingDocumentPassword = null;
        removeViewer();
        closeSession();
        showError();
    }

    void onPdfViewReady(@NonNull PdfView view) {
        pdfView = view;
        hideToolbox();
    }

    void requestDocumentPassword(@NonNull ReaderFragment fragment) {
        if (!canShowReaderUi()) {
            passwordPromptPending = true;
            return;
        }
        passwordPromptPending = false;
        if (documentPassword != null && !retainedPasswordAttempted) {
            retainedPasswordAttempted = true;
            fragment.submitPassword(new String(documentPassword));
            return;
        }
        boolean previousPasswordFailed = pendingDocumentPassword != null || documentPassword != null;
        clearPassword(documentPassword);
        clearPassword(pendingDocumentPassword);
        documentPassword = null;
        pendingDocumentPassword = null;
        dismissPasswordDialog();

        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        input.setHint(R.string.pdf_reader_password_hint);
        input.setContentDescription(getString(R.string.pdf_reader_password_description));

        passwordDialog = new AlertDialog.Builder(this)
                .setTitle(R.string.pdf_reader_password_title)
                .setMessage(previousPasswordFailed
                        ? R.string.pdf_reader_password_incorrect
                        : R.string.pdf_reader_password_body)
                .setView(input)
                .setPositiveButton(R.string.pdf_reader_password_open, (dialog, which) -> {
                    String submitted = input.getText().toString();
                    pendingDocumentPassword = submitted.toCharArray();
                    input.getText().clear();
                    fragment.submitPassword(submitted);
                })
                // Choosing not to enter the password closes the reader. Handing the cancel to the
                // viewer made it fail the load, which showed "could not be opened" for a file
                // that is fine.
                .setNegativeButton(android.R.string.cancel, (dialog, which) -> finishClosed())
                .setOnCancelListener(dialog -> finishClosed())
                .create();
        passwordDialog.setCanceledOnTouchOutside(false);
        passwordDialog.setOnShowListener(dialog -> input.requestFocus());
        passwordDialog.show();
    }

    private void dismissPasswordDialog() {
        if (passwordDialog != null) {
            passwordDialog.dismiss();
            passwordDialog = null;
        }
    }

    private void clearPasswords() {
        clearPassword(documentPassword);
        clearPassword(pendingDocumentPassword);
        documentPassword = null;
        pendingDocumentPassword = null;
    }

    private static void clearPassword(@Nullable char[] password) {
        if (password != null) Arrays.fill(password, '\0');
    }

    /**
     * The viewer reports load success before it assigns the document to its
     * own view. Posting one main-thread turn lets that assignment create the
     * page layout before the restore is attempted.
     */
    private void schedulePendingPageRestore() {
        if (pendingPageTarget <= 0 || pendingRestoreIssued) return;
        if (pdfView == null || pageCount <= 0) return;
        if (pendingPageTarget > pageCount) {
            pendingPageTarget = 0;
            return;
        }
        PdfView view = pdfView;
        int target = pendingPageTarget;
        view.post(() -> restorePendingPage(view, target));
    }

    private void restorePendingPage(@NonNull PdfView view, int target) {
        if (view != pdfView || isFinishing() || isDestroyed()) return;
        if (pendingPageTarget != target || pendingRestoreIssued) return;
        if (target < 1 || target > pageCount) {
            pendingPageTarget = 0;
            return;
        }

        // scrollToPage can synchronously report the destination, so the issued
        // flag must be visible during the call. A failed call gives tracking
        // straight back to the live viewport instead of freezing or crashing.
        pendingRestoreIssued = true;
        try {
            view.scrollToPage(target - 1);
        } catch (IllegalStateException notReady) {
            pendingRestoreIssued = false;
            if (BuildConfig.DEBUG) throw notReady;
            pendingPageTarget = 0;
        }
    }

    void onPageChanged(@NonNull PdfView view, int firstVisiblePage) {
        if (view != pdfView) return;
        int page = firstVisiblePage + 1;
        if (page < 1) return;
        if (pendingPageTarget > 0) {
            // Before the scroll is issued every report is the viewer's opening
            // position; after it, the pages it passes on the way are not where
            // the person is either. Only arrival at the target hands tracking
            // back, so a restore can never be erased by its own journey.
            if (!pendingRestoreIssued || page < pendingPageTarget) return;
            pendingPageTarget = 0;
            pendingRestoreIssued = false;
        }
        if (page == currentPage) return;
        currentPage = page;
        updatePageLabel();
    }

    private void updatePageLabel() {
        if (pageView == null) return;
        if (pageCount <= 0) {
            pageView.setText(R.string.pdf_reader_page_unknown);
            return;
        }
        pageView.setText(getString(R.string.pdf_reader_page_of, currentPage, pageCount));
    }

    /* -------------------------------------------------------------- states -- */

    private void showLoading() {
        loadingView.setVisibility(View.VISIBLE);
        errorView.setVisibility(View.GONE);
        contentContainer.setVisibility(View.INVISIBLE);
        setCoveredContentHidden(true);
        setActionsEnabled(false);
    }

    private void showViewer() {
        loadingView.setVisibility(View.GONE);
        errorView.setVisibility(View.GONE);
        contentContainer.setVisibility(View.VISIBLE);
        setCoveredContentHidden(false);
        setActionsEnabled(true);
    }

    private void showError() {
        failed = true;
        loadingView.setVisibility(View.GONE);
        contentContainer.setVisibility(View.GONE);
        errorView.setVisibility(View.VISIBLE);
        setCoveredContentHidden(true);
        setActionsEnabled(false);
        dismissTools();

        // The error is where the person now is, so that is where focus goes, and
        // it is announced without a cause anyone would have to decode.
        errorView.setFocusable(true);
        errorView.setFocusableInTouchMode(true);
        errorView.requestFocus();
        errorView.announceForAccessibility(
                getString(R.string.pdf_reader_error_title) + ". " + getString(R.string.pdf_reader_error_body));
    }

    /** An overlay covers the reader, so a screen reader must not walk what is behind it. */
    private void setCoveredContentHidden(boolean hidden) {
        int mode = hidden
                ? View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
                : View.IMPORTANT_FOR_ACCESSIBILITY_AUTO;
        topBar.setImportantForAccessibility(mode);
        contentContainer.setImportantForAccessibility(mode);
    }

    private void setActionsEnabled(boolean enabled) {
        boolean idle = enabled && !sharePending && !savePending && !signaturePending;
        searchButton.setEnabled(enabled);
        toolsButton.setEnabled(enabled);
        shareButton.setEnabled(idle);
        saveButton.setEnabled(idle);
        float alpha = enabled ? 1f : 0.4f;
        searchButton.setAlpha(alpha);
        toolsButton.setAlpha(alpha);
        shareButton.setAlpha(idle ? 1f : 0.4f);
        saveButton.setAlpha(idle ? 1f : 0.4f);
    }

    private void hideMessageBanner() {
        if (messageView != null) messageView.setVisibility(View.GONE);
    }

    private void showMessage(int textId) {
        messageView.setText(textId);
        messageView.setVisibility(View.VISIBLE);
        messageView.announceForAccessibility(getString(textId));
        main.removeCallbacks(hideMessage);
        main.postDelayed(hideMessage, MESSAGE_VISIBLE_MS);
    }

    /* ------------------------------------------------------------- actions -- */

    @Nullable
    private PdfViewerFragment viewer() {
        Fragment fragment = getSupportFragmentManager().findFragmentByTag(FRAGMENT_TAG);
        return fragment instanceof PdfViewerFragment ? (PdfViewerFragment) fragment : null;
    }

    /** The reader draws its own chrome, so the built-in floating toolbox stays hidden. */
    private void hideToolbox() {
        PdfViewerFragment viewer = viewer();
        if (viewer != null && viewer.getView() != null) viewer.setToolboxVisible(false);
    }

    private boolean isSearchActive() {
        return searchActive && (searchDialog == null || searchDialog.isShowing());
    }

    /**
     * Search deliberately does not use PdfViewerFragment's highlight pipeline. That pipeline
     * materializes all highlight rectangles on the main thread and has produced user-perceived
     * ANRs for match-heavy documents. Our page-only search runs on the existing background
     * executor, remains cancellable, and moves the same native PdfView to each result.
     */
    private void setSearchActive(boolean active) {
        if (!active) {
            dismissSearch();
            return;
        }
        searchActive = true;
        if (session == null || pdfView == null || executor == null) return;
        showSearch();
    }

    private void showSearch() {
        if (searchDialog != null && searchDialog.isShowing()) return;

        float density = getResources().getDisplayMetrics().density;
        int side = Math.round(24f * density);
        int gap = Math.round(12f * density);

        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(side, 0, side, 0);

        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint(R.string.pdf_reader_search_hint);
        input.setContentDescription(getString(R.string.pdf_reader_search_hint));
        body.addView(input, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        TextView status = new TextView(this);
        LinearLayout.LayoutParams statusLayout = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        statusLayout.topMargin = gap;
        body.addView(status, statusLayout);

        LinearLayout navigation = new LinearLayout(this);
        navigation.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams navigationLayout = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        navigationLayout.topMargin = gap;
        body.addView(navigation, navigationLayout);

        Button previous = new Button(this);
        previous.setText(R.string.pdf_reader_search_previous);
        previous.setEnabled(false);
        navigation.addView(previous, new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        Button next = new Button(this);
        next.setText(R.string.pdf_reader_search_next);
        next.setEnabled(false);
        LinearLayout.LayoutParams nextLayout = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        nextLayout.setMarginStart(gap);
        navigation.addView(next, nextLayout);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(R.string.pdf_reader_search_title)
                .setView(body)
                .setPositiveButton(R.string.pdf_reader_search_action, null)
                .setNegativeButton(android.R.string.cancel, null)
                .create();
        dialog.setOnDismissListener(ignored -> {
            if (searchDialog == dialog) clearSearchState();
        });
        dialog.setOnShowListener(ignored -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> runSearch());
            input.requestFocus();
        });

        searchInput = input;
        searchStatus = status;
        searchPreviousButton = previous;
        searchNextButton = next;
        previous.setOnClickListener(view -> moveToSearchResult(-1));
        next.setOnClickListener(view -> moveToSearchResult(1));
        searchDialog = dialog;
        dialog.show();
    }

    private void runSearch() {
        if (searchInput == null || searchStatus == null || session == null || executor == null) {
            showMessage(R.string.pdf_reader_search_unavailable);
            return;
        }
        String query = searchInput.getText().toString();
        if (query.strip().isEmpty() || query.length() > PdfReaderSearchEngine.MAX_QUERY_CHARACTERS) {
            searchStatus.setText(R.string.pdf_reader_search_invalid);
            return;
        }

        cancelSearchTask();
        int generation = ++searchGeneration;
        searchPages = new int[0];
        searchResultIndex = 0;
        setSearchNavigationEnabled(false);
        searchStatus.setText(R.string.pdf_reader_searching);

        final PdfReaderDocumentSession activeSession = session;
        final char[] password = documentPassword == null ? null : documentPassword.clone();
        try {
            searchTask = executor.submit(() -> {
                PdfReaderSearchEngine.Result result;
                try {
                    result = new PdfReaderSearchEngine(getApplicationContext()).search(
                            activeSession.snapshotForVerification(), password, query);
                } catch (RuntimeException failure) {
                    clearPassword(password);
                    result = new PdfReaderSearchEngine.Result(
                            PdfReaderSearchEngine.Status.UNAVAILABLE, new int[0], false);
                }
                final PdfReaderSearchEngine.Result completed = result;
                main.post(() -> showSearchResults(generation, completed));
            });
        } catch (RejectedExecutionException rejected) {
            clearPassword(password);
            searchStatus.setText(R.string.pdf_reader_search_unavailable);
        }
    }

    private void showSearchResults(int generation, @NonNull PdfReaderSearchEngine.Result result) {
        if (generation != searchGeneration || searchDialog == null || !searchDialog.isShowing()) return;
        searchTask = null;
        if (result.status == PdfReaderSearchEngine.Status.CANCELLED) return;
        if (result.status == PdfReaderSearchEngine.Status.INVALID_QUERY) {
            searchStatus.setText(R.string.pdf_reader_search_invalid);
            return;
        }
        if (result.status != PdfReaderSearchEngine.Status.COMPLETE) {
            searchStatus.setText(R.string.pdf_reader_search_unavailable);
            return;
        }
        searchPages = result.matchingPages;
        if (searchPages.length == 0) {
            searchStatus.setText(R.string.pdf_reader_search_none);
            return;
        }

        searchResultIndex = 0;
        for (int index = 0; index < searchPages.length; index++) {
            if (searchPages[index] + 1 >= currentPage) {
                searchResultIndex = index;
                break;
            }
        }
        setSearchNavigationEnabled(true);
        showCurrentSearchResult(result.truncated);
    }

    private void moveToSearchResult(int delta) {
        if (searchPages.length == 0) return;
        searchResultIndex = (searchResultIndex + delta + searchPages.length) % searchPages.length;
        showCurrentSearchResult(false);
    }

    private void showCurrentSearchResult(boolean truncated) {
        if (pdfView == null || searchStatus == null || searchPages.length == 0) return;
        int page = searchPages[searchResultIndex];
        try { pdfView.scrollToPage(page); }
        catch (IllegalStateException unavailable) {
            searchStatus.setText(R.string.pdf_reader_search_unavailable);
            setSearchNavigationEnabled(false);
            return;
        }
        searchStatus.setText(getString(truncated
                        ? R.string.pdf_reader_search_result_limited
                        : R.string.pdf_reader_search_result,
                searchResultIndex + 1, searchPages.length, page + 1));
    }

    private void setSearchNavigationEnabled(boolean enabled) {
        if (searchPreviousButton != null) searchPreviousButton.setEnabled(enabled);
        if (searchNextButton != null) searchNextButton.setEnabled(enabled);
    }

    private void dismissSearch() {
        AlertDialog dialog = searchDialog;
        if (dialog == null) {
            clearSearchState();
            return;
        }
        dialog.dismiss();
    }

    private void clearSearchState() {
        cancelSearchTask();
        searchGeneration++;
        searchActive = false;
        searchPages = new int[0];
        searchResultIndex = 0;
        searchDialog = null;
        searchInput = null;
        searchStatus = null;
        searchPreviousButton = null;
        searchNextButton = null;
    }

    private void cancelSearchTask() {
        Future<?> task = searchTask;
        searchTask = null;
        if (task != null) task.cancel(true);
    }

    private void share() {
        if (sharePending || session == null || ref == null) return;
        sharePending = true;
        setActionsEnabled(errorView.getVisibility() != View.VISIBLE);
        actions.share(ref, displayName, result -> {
            sharePending = false;
            setActionsEnabled(errorView.getVisibility() != View.VISIBLE);
            // A share that did not happen leaves the document exactly where it was.
            if (result == null || !result.completed()) showMessage(R.string.pdf_reader_share_failed);
        });
    }

    /**
     * Keep a copy of the PDF the reader is looking at.
     *
     * Someone who arrived here from a browser or a mail attachment has the
     * document on screen but nothing of their own yet; sharing passes it on,
     * which is not the same as keeping it.
     */
    private void save() {
        if (savePending || sharePending || session == null || ref == null) return;
        savePending = true;
        setActionsEnabled(errorView.getVisibility() != View.VISIBLE);
        actions.save(ref, displayName, result -> {
            savePending = false;
            setActionsEnabled(errorView.getVisibility() != View.VISIBLE);
            // A save that did not happen leaves the document exactly where it was.
            showMessage(result != null && result.completed()
                    ? R.string.pdf_reader_saved
                    : R.string.pdf_reader_save_failed);
        });
    }

    /* --------------------------------------------------------------- tools -- */

    private void showTools() {
        if (toolsDialog != null && toolsDialog.isShowing()) return;

        View sheet = LayoutInflater.from(this).inflate(R.layout.pdf_reader_tools_sheet, null, false);
        LinearLayout list = sheet.findViewById(R.id.pdf_reader_tool_list);
        LayoutInflater inflater = LayoutInflater.from(this);
        TextView verifyRow = (TextView) inflater.inflate(R.layout.pdf_reader_tool_row, list, false);
        verifyRow.setText(R.string.pdf_reader_verify_signatures);
        verifyRow.setContentDescription(getString(R.string.pdf_reader_verify_signatures_description));
        verifyRow.setOnClickListener(view -> verifyDigitalSignatures());
        list.addView(verifyRow);
        for (String[] tool : TOOLS) {
            if (!PdfReaderLaunchContract.toolPaths().contains(tool[0])) continue;
            TextView row = (TextView) inflater.inflate(R.layout.pdf_reader_tool_row, list, false);
            row.setText(tool[1]);
            row.setContentDescription(getString(R.string.pdf_reader_tool_row, tool[1]));
            final String path = tool[0];
            row.setOnClickListener(view -> finishWithTool(path));
            list.addView(row);
        }

        View scroller = sheet.findViewById(R.id.pdf_reader_tool_scroll);
        scroller.getLayoutParams().height =
                Math.round(getResources().getDisplayMetrics().heightPixels * 0.55f);

        sheet.findViewById(R.id.pdf_reader_tools_close).setOnClickListener(view -> dismissTools());
        sheet.setPadding(
                sheet.getPaddingLeft(),
                sheet.getPaddingTop(),
                sheet.getPaddingRight(),
                sheet.getPaddingBottom() + bottomInset);

        Dialog dialog = new Dialog(this, R.style.PdfReaderToolsDialog);
        dialog.setContentView(sheet);
        dialog.setCanceledOnTouchOutside(true);
        Window window = dialog.getWindow();
        if (window != null) window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        toolsDialog = dialog;
        dialog.show();

        // Applied after show, where the window actually exists, so the anchored
        // size is the one that survives to the screen.
        if (window != null) {
            window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT);
            window.setGravity(Gravity.BOTTOM);
        }
    }

    private void dismissTools() {
        if (toolsDialog != null) {
            toolsDialog.dismiss();
            toolsDialog = null;
        }
    }

    private void verifyDigitalSignatures() {
        if (isFinishing() || isDestroyed()) return;
        if (signaturePending || session == null || executor == null) return;
        dismissTools();
        signaturePending = true;
        setActionsEnabled(errorView.getVisibility() != View.VISIBLE);
        signatureDialog = new AlertDialog.Builder(this)
                .setTitle(R.string.pdf_reader_signature_checking_title)
                .setMessage(R.string.pdf_reader_signature_checking_body)
                .setCancelable(false)
                .create();
        signatureDialog.show();
        final PdfReaderDocumentSession activeSession = session;
        final char[] verificationPassword = documentPassword == null
                ? null : documentPassword.clone();
        try {
            executor.execute(() -> {
                PdfSignatureReport report = verifySignatures(activeSession, verificationPassword);
                main.post(() -> showSignatureReport(report));
            });
        } catch (RejectedExecutionException rejected) {
            clearPassword(verificationPassword);
            showSignatureReport(PdfSignatureReport.malformed());
        }
    }

    private PdfSignatureReport verifySignatures(PdfReaderDocumentSession activeSession,
            @Nullable char[] password) {
        try {
            return new PdfSignatureVerifier(getApplicationContext())
                    .verify(activeSession.snapshotForVerification(), password);
        } catch (RuntimeException unavailable) {
            return PdfSignatureReport.malformed();
        } finally {
            clearPassword(password);
        }
    }

    private void showSignatureReport(@NonNull PdfSignatureReport report) {
        if (isFinishing() || isDestroyed()) return;
        signatureVerificationPresented = true;
        signaturePending = false;
        setActionsEnabled(errorView.getVisibility() != View.VISIBLE);
        dismissSignatureDialog();
        String message;
        if (report.encrypted) {
            message = getString(R.string.pdf_reader_signature_encrypted);
        } else if (report.malformed) {
            message = getString(R.string.pdf_reader_signature_malformed);
        } else if (report.signatures.isEmpty()) {
            message = getString(R.string.pdf_reader_signature_none);
        } else {
            StringBuilder text = new StringBuilder();
            for (int index = 0; index < report.signatures.size(); index++) {
                if (index > 0) text.append("\n\n");
                PdfSignatureReport.Signature signature = report.signatures.get(index);
                text.append(getString(R.string.pdf_reader_signature_number, index + 1)).append('\n')
                        .append(getString(R.string.pdf_reader_signature_signer, signature.signerName)).append('\n')
                        .append(getString(R.string.pdf_reader_signature_integrity,
                                integrityText(signature))).append('\n')
                        .append(getString(R.string.pdf_reader_signature_trust,
                                trustText(signature.trust))).append('\n')
                        .append(getString(R.string.pdf_reader_signature_validity,
                                validityText(signature))).append('\n')
                        .append(getString(R.string.pdf_reader_signature_revocation,
                                revocationText(signature.revocation))).append('\n')
                        .append(getString(R.string.pdf_reader_signature_timestamp,
                                timestampText(signature.timestampLtv)));
                if (signature.legacyWeakAlgorithm) {
                    text.append('\n').append(getString(R.string.pdf_reader_signature_sha1_warning));
                }
            }
            text.append("\n\n").append(getString(R.string.pdf_reader_signature_offline_note));
            message = text.toString();
        }
        AlertDialog.Builder builder = new AlertDialog.Builder(this)
                .setTitle(R.string.pdf_reader_signature_results_title)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok, null);
        if (PdfSignatureReport.fullyVerified(report)) {
            builder.setNeutralButton(R.string.pdf_reader_verified_copy_action,
                    (dialog, which) -> createVerifiedCopy(report));
        }
        signatureDialog = builder.create();
        signatureDialog.show();
    }

    private void createVerifiedCopy(PdfSignatureReport report) {
        dismissSignatureDialog();
        signatureDialog = new AlertDialog.Builder(this)
                .setTitle(R.string.pdf_reader_verified_copy_action)
                .setItems(new CharSequence[] { getString(R.string.pdf_reader_verified_copy_print),
                        getString(R.string.pdf_reader_verified_copy_share) },
                        (dialog, which) -> createVerifiedCopy(report, which == 0))
                .setNegativeButton(android.R.string.cancel, null).create();
        signatureDialog.show();
    }

    private void createVerifiedCopy(PdfSignatureReport report, boolean printing) {
        if (!PdfSignatureReport.fullyVerified(report) || signaturePending || session == null
                || executor == null || isFinishing() || isDestroyed()) return;
        signaturePending = true;
        setActionsEnabled(errorView.getVisibility() != View.VISIBLE);
        dismissSignatureDialog();
        signatureDialog = new AlertDialog.Builder(this)
                .setMessage(R.string.pdf_reader_verified_copy_progress)
                .setCancelable(false).create();
        signatureDialog.show();
        final PdfReaderDocumentSession activeSession = session;
        final String name = displayName;
        final Path outputDir = getCacheDir().toPath().resolve(PdfVerifiedCopy.CACHE_DIRECTORY);
        final char[] password = documentPassword == null ? null : documentPassword.clone();
        final Date checkedAt = Date.from(report.signatures.get(0).evaluatedAt);
        verifiedCopyPassword = password;
        try {
            executor.execute(() -> {
                PdfVerifiedCopy.Result result = null;
                try {
                    Path snapshot = activeSession.snapshotForVerification();
                    result = printing
                            ? PdfVerifiedCopy.prepareForPrint(getApplicationContext(), snapshot, password)
                            : PdfVerifiedCopy.create(getApplicationContext(), snapshot, password, name,
                                    checkedAt, outputDir);
                } catch (Exception failure) {
                    // Keep file contents, paths and credentials out of logs and UI messages.
                } finally {
                    clearPassword(password);
                }
                final PdfVerifiedCopy.Result completed = result;
                main.post(() -> showVerifiedCopy(completed, printing, checkedAt));
            });
        } catch (RejectedExecutionException unavailable) {
            clearPassword(password);
            showVerifiedCopy(null, printing, checkedAt);
        }
    }

    private void showVerifiedCopy(@Nullable PdfVerifiedCopy.Result copy, boolean printing, Date checkedAt) {
        verifiedCopyPassword = null;
        if (isFinishing() || isDestroyed()) return;
        signaturePending = false;
        setActionsEnabled(errorView.getVisibility() != View.VISIBLE);
        dismissSignatureDialog();
        if (copy == null) {
            showMessage(R.string.pdf_reader_verified_copy_failed);
        } else if (copy.outcome == PdfVerifiedCopy.Outcome.NO_SIGNATURE_BOX) {
            showMessage(R.string.pdf_reader_verified_copy_no_box);
        } else if (copy.outcome == PdfVerifiedCopy.Outcome.UNSUPPORTED_SIGNATURE_BOX) {
            showMessage(R.string.pdf_reader_verified_copy_unsupported_box);
        } else if (copy.outcome == PdfVerifiedCopy.Outcome.PASSWORD_UNSUPPORTED) {
            showMessage(R.string.pdf_reader_verified_copy_password_unsupported);
        } else if (printing) {
            printVerifiedCopy(copy, checkedAt);
        } else {
            shareVerifiedCopy(copy);
        }
    }

    private void shareVerifiedCopy(PdfVerifiedCopy.Result copy) {
        try {
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", copy.path.toFile());
            Intent send = new Intent(Intent.ACTION_SEND).setType("application/pdf")
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            send.setClipData(ClipData.newRawUri("PDF", uri));
            startActivity(Intent.createChooser(send, getString(R.string.pdf_reader_verified_copy_share)));
        } catch (RuntimeException unavailable) {
            showMessage(R.string.pdf_reader_verified_copy_failed);
        }
    }

    private void printVerifiedCopy(PdfVerifiedCopy.Result copy, Date checkedAt) {
        PdfVerifiedCopyPrintAdapter adapter = new PdfVerifiedCopyPrintAdapter(this, copy, documentPassword, checkedAt,
                PdfVerifiedCopy.copyName(displayName));
        try {
            PrintManager manager = (PrintManager) getSystemService(PRINT_SERVICE);
            if (manager == null) throw new IllegalStateException("Printing unavailable");
            manager.print(PdfVerifiedCopy.copyName(displayName), adapter, null);
        } catch (RuntimeException unavailable) {
            adapter.onFinish();
            showMessage(R.string.pdf_reader_verified_copy_failed);
        }
    }

    private String integrityText(PdfSignatureReport.Signature signature) {
        switch (signature.integrity) {
            case VALID:
                return getString(signature.coverage == PdfSignatureReport.Coverage.WHOLE_DOCUMENT
                        ? R.string.pdf_reader_signature_integrity_whole
                        : R.string.pdf_reader_signature_integrity_revision);
            case INVALID: return getString(R.string.pdf_reader_signature_integrity_invalid);
            case UNSUPPORTED: return getString(R.string.pdf_reader_signature_unsupported);
            default: return getString(R.string.pdf_reader_signature_indeterminate);
        }
    }

    private String trustText(PdfSignatureReport.Trust value) {
        switch (value) {
            case TRUSTED: return getString(R.string.pdf_reader_signature_trusted);
            case TRUSTED_CCA_INDIA_2022: return getString(R.string.pdf_reader_signature_trusted_cca);
            case UNTRUSTED: return getString(R.string.pdf_reader_signature_untrusted);
            default: return getString(R.string.pdf_reader_signature_indeterminate);
        }
    }

    private String validityText(PdfSignatureReport.Signature signature) {
        switch (signature.certificateValidity) {
            case VALID: return getString(R.string.pdf_reader_signature_certificate_valid);
            case EXPIRED: return signature.certificateNotAfter == null
                    ? getString(R.string.pdf_reader_signature_certificate_expired)
                    : getString(R.string.pdf_reader_signature_certificate_expired_on,
                    signature.certificateNotAfter.toString().substring(0, 10));
            case NOT_YET_VALID: return getString(R.string.pdf_reader_signature_certificate_future);
            default: return getString(R.string.pdf_reader_signature_indeterminate);
        }
    }

    private String revocationText(PdfSignatureReport.Revocation value) {
        switch (value) {
            case GOOD: return getString(R.string.pdf_reader_signature_revocation_good);
            case REVOKED: return getString(R.string.pdf_reader_signature_revocation_revoked);
            case OFFLINE_NOT_CHECKED: return getString(R.string.pdf_reader_signature_revocation_offline);
            default: return getString(R.string.pdf_reader_signature_indeterminate);
        }
    }

    private String timestampText(PdfSignatureReport.TimestampLtv value) {
        switch (value) {
            case VALID: return getString(R.string.pdf_reader_signature_timestamp_valid);
            case INVALID: return getString(R.string.pdf_reader_signature_timestamp_invalid);
            case ABSENT: return getString(R.string.pdf_reader_signature_timestamp_absent);
            case PRESENT_NOT_VERIFIED: return getString(R.string.pdf_reader_signature_timestamp_unverified);
            default: return getString(R.string.pdf_reader_signature_indeterminate);
        }
    }

    private void dismissSignatureDialog() {
        if (signatureDialog != null) {
            signatureDialog.dismiss();
            signatureDialog = null;
        }
    }

    /* -------------------------------------------------------------- result -- */

    private void finishClosed() {
        if (resultSent) return;
        resultSent = true;
        setResult(RESULT_OK, PdfReaderLaunchContract.closedResultIntent());
        finish();
    }

    private void finishWithTool(@NonNull String path) {
        if (resultSent) return;
        Intent result;
        try {
            result = PdfReaderLaunchContract.toolResultIntent(path);
        } catch (PdfReaderLaunchContract.Failure ignored) {
            finishClosed();
            return;
        }
        resultSent = true;
        dismissTools();
        setResult(RESULT_OK, result);
        finish();
    }

    /* ----------------------------------------------------------- lifecycle -- */

    @Override
    public void onConfigurationChanged(@NonNull Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // The tools sheet sizes itself from the current viewport. A handled
        // rotation keeps this Activity alive, so discard the old geometry and
        // let the next tap build a correctly sized sheet for the new viewport.
        dismissTools();
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideToolbox();
    }

    private boolean canShowReaderUi() {
        return !isFinishing() && !isDestroyed()
                && getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)
                && !getSupportFragmentManager().isStateSaved();
    }

    /**
     * beta01 keeps its loading collector alive after STOPPED and shows its private password
     * DialogFragment before our hook. Remove an unfinished viewer before state saving to cancel
     * that collector and load job. Keep the immutable session, so return never copies it again.
     */
    private void suspendLoadingViewer() {
        if (pageCount > 0 && !isChangingConfigurations()) return;
        FragmentManager fragments = getSupportFragmentManager();
        Fragment fragment = fragments.findFragmentByTag(FRAGMENT_TAG);
        if (fragment == null || fragments.isDestroyed()) return;
        dismissPasswordDialog();
        passwordPromptPending = false;
        if (pendingDocumentPassword != null) {
            clearPassword(documentPassword);
            documentPassword = pendingDocumentPassword;
            pendingDocumentPassword = null;
        }
        retainedPasswordAttempted = false;
        viewerNeedsAttach = !isFinishing() && session != null && !failed;
        removeViewer();
    }

    @Override
    protected void onPause() {
        if (passwordDialog != null && passwordDialog.isShowing()) {
            passwordPromptPending = true;
            // Lifecycle dismissal is not user cancellation. Discard any unsubmitted password.
            dismissPasswordDialog();
        }
        super.onPause();
    }

    @Override
    protected void onStop() {
        suspendLoadingViewer();
        super.onStop();
    }

    @Override
    protected void onPostResume() {
        super.onPostResume();
        // ON_RESUME can be dispatched after onPostResume returns. Attach only after that event.
        main.post(this::resumeLoadingViewer);
    }

    private void resumeLoadingViewer() {
        if (!canShowReaderUi()) return;
        FragmentManager fragments = getSupportFragmentManager();
        if (viewerNeedsAttach && session != null && !failed) attachViewer(session);
        Fragment fragment = fragments.findFragmentByTag(FRAGMENT_TAG);
        if (passwordPromptPending && pageCount == 0 && fragment instanceof ReaderFragment) {
            requestDocumentPassword((ReaderFragment) fragment);
        }
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        suspendLoadingViewer();
        super.onSaveInstanceState(outState);
        // The reader has no result launchers to restore. Pagination/form/view state can be huge
        // and is unused because this Activity explicitly reopens from its opaque ref.
        outState.clear();
        outState.putInt(STATE_PAGE, currentPage);
        outState.putBoolean(STATE_SEARCH, isSearchActive());
        outState.putBoolean(STATE_FAILED, failed);
        outState.putBoolean(STATE_SIGNATURE_PRESENTED, signatureVerificationPresented);
    }

    @Override
    public Object onRetainCustomNonConfigurationInstance() {
        // The staged snapshot outlives this instance, so the next one attaches a
        // fresh fragment to the same session instead of copying the file again.
        if (session == null) return null;
        char[] password = documentPassword;
        documentPassword = null;
        return new RetainedSession(session, password);
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacks(hideMessage);
        dismissSearch();
        dismissTools();
        dismissSignatureDialog();
        dismissPasswordDialog();
        // Framework fragment state is deliberately omitted, so explicitly clear its non-config
        // ViewModels on recreation instead of leaving an unused old document behind.
        if (isChangingConfigurations()) removeViewer();
        if (actions != null) actions.close();
        if (executor != null) executor.shutdownNow();
        // A retained session belongs to the next instance. Only a real teardown
        // closes it, and close is idempotent by contract.
        if (!isChangingConfigurations()) closeSession();
        clearPasswords();
        clearPassword(verifiedCopyPassword);
        verifiedCopyPassword = null;
        session = null;
        pdfView = null;
        super.onDestroy();
    }

    /* ------------------------------------------------------------ fragment -- */

    /** The stock viewer with its toolbox hidden and its page position reported back. */
    public static final class ReaderFragment extends PdfViewerFragment {
        /** pdf-viewer-fragment 1.0.0-beta01 shows its own password dialog under this tag. */
        private static final String STOCK_PASSWORD_DIALOG_TAG = "password-dialog";
        private PdfView readerView;

        @Nullable
        private PdfReaderActivity host() {
            return getActivity() instanceof PdfReaderActivity ? (PdfReaderActivity) getActivity() : null;
        }

        @Override
        public void onPasswordRequestedState$pdf_viewer_fragment() {
            PdfReaderActivity host = host();
            if (host == null) return;
            // Keep the SDK dialog attached but hidden. Removing it makes beta01 construct a
            // new dialog on a wrong-password retry, then dereference it before show() commits.
            // Only PDF Chef's prompt is visible and captures the password in memory.
            hideStockPasswordDialog();
            host.requestDocumentPassword(this);
        }

        private void hideStockPasswordDialog() {
            FragmentManager fragments = getChildFragmentManager();
            try {
                fragments.executePendingTransactions();
            } catch (IllegalStateException busy) {
                // Mid-transaction: try again once the manager is idle rather than
                // leaving a second password prompt on screen.
                View view = getView();
                if (view != null) view.post(this::hideStockPasswordDialog);
                return;
            }
            Fragment stock = fragments.findFragmentByTag(STOCK_PASSWORD_DIALOG_TAG);
            if (stock instanceof DialogFragment) {
                Dialog dialog = ((DialogFragment) stock).getDialog();
                if (dialog != null) dialog.hide();
            }
        }

        @SuppressLint("RestrictedApi")
        void submitPassword(@NonNull String password) {
            getDocumentViewModel().loadDocument$pdf_viewer_fragment(getDocumentUri(), password);
        }

        @Override
        public void onLoadDocumentSuccess(@NonNull PdfDocument document) {
            super.onLoadDocumentSuccess(document);
            PdfReaderActivity host = host();
            if (host != null && readerView != null) {
                host.onDocumentLoaded(readerView, document.getPageCount());
            }
        }

        @Override
        public void onLoadDocumentError(@NonNull Throwable error) {
            super.onLoadDocumentError(error);
            PdfReaderActivity host = host();
            if (host != null) host.onDocumentFailed();
        }

        @OptIn(markerClass = ExperimentalPdfApi.class)
        @Override
        public void onPdfViewCreated(@NonNull PdfView pdfView) {
            super.onPdfViewCreated(pdfView);
            PdfReaderAccessibilityGuard.install(pdfView);
            readerView = pdfView;
            setToolboxVisible(false);
            pdfView.addOnViewportChangedListener(new PdfView.OnViewportChangedListener() {
                @Override
                public void onViewportChanged(
                        int firstVisiblePage,
                        int visiblePagesCount,
                        @NonNull SparseArray<RectF> visiblePageAreas,
                        float zoomLevel) {
                    PdfReaderActivity host = host();
                    if (host != null) host.onPageChanged(pdfView, firstVisiblePage);
                }
            });
            PdfReaderActivity host = host();
            if (host != null) host.onPdfViewReady(pdfView);
        }

        /** Immersive mode would hide the reader's own bar mid-scroll. Keep the chrome steady. */
        @Override
        public void onRequestImmersiveMode(boolean enterImmersive) {
            // Deliberately not forwarded.
        }
    }
}
