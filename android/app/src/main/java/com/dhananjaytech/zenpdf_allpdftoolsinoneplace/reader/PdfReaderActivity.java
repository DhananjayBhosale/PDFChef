package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import android.app.Dialog;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.RectF;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.SparseArray;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.fragment.app.Fragment;
import androidx.pdf.ExperimentalPdfApi;
import androidx.pdf.PdfDocument;
import androidx.pdf.view.PdfView;
import androidx.pdf.viewer.fragment.PdfViewerFragment;

import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.PdfChefApplication;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.R;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents.DocumentLifecycleCoordinator;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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

        RetainedSession(PdfReaderDocumentSession session) {
            this.session = session;
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
    private boolean sharePending;
    private boolean savePending;
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
        super.onCreate(savedInstanceState);

        Intent intent = getIntent();
        String requestedRef = intent == null ? null : intent.getStringExtra(PdfReaderLaunchContract.EXTRA_REF);
        String requestedName = intent == null
                ? null : intent.getStringExtra(PdfReaderLaunchContract.EXTRA_DISPLAY_NAME);
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
        if (carried instanceof RetainedSession) session = ((RetainedSession) carried).session;

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
        Fragment current = getSupportFragmentManager().findFragmentByTag(FRAGMENT_TAG);
        if (current != null) {
            getSupportFragmentManager().beginTransaction().remove(current).commitNowAllowingStateLoss();
        }
        pdfView = null;
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
        prepareDocument();
    }

    void onDocumentLoaded(int pages) {
        pageCount = Math.max(pages, 0);
        if (currentPage < 1) currentPage = 1;
        showViewer();
        updatePageLabel();
        // The page the person was on, and the search they had open, survive the
        // rotation that rebuilt this fragment.
        restorePendingPage();
        if (searchActive) setSearchActive(true);
        hideToolbox();
    }

    void onDocumentFailed() {
        // A snapshot that could not be read is not worth keeping staged.
        removeViewer();
        closeSession();
        showError();
    }

    void onPdfViewReady(@NonNull PdfView view) {
        pdfView = view;
        hideToolbox();
        restorePendingPage();
    }

    /**
     * Both halves have to be there: the view to scroll, and a page count to
     * scroll within. Whichever readiness callback lands second is the one that
     * issues the scroll, and a target the document cannot honour is dropped
     * rather than clamped onto some other page.
     */
    private void restorePendingPage() {
        if (pendingPageTarget <= 0 || pendingRestoreIssued) return;
        if (pdfView == null || pageCount <= 0) return;
        if (pendingPageTarget > pageCount) {
            pendingPageTarget = 0;
            return;
        }
        pendingRestoreIssued = true;
        pdfView.scrollToPage(pendingPageTarget - 1);
    }

    void onPageChanged(int firstVisiblePage) {
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
        boolean idle = enabled && !sharePending && !savePending;
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
        if (viewer != null) viewer.setToolboxVisible(false);
    }

    /**
     * The viewer is the authority while it exists. Its own close control can end
     * search without telling this class, so a cached flag would swallow the next
     * Back or toolbar press and could reopen a search the person had closed. The
     * cache is only the answer before the viewer is there, and across rotation.
     */
    private boolean isSearchActive() {
        PdfViewerFragment viewer = viewer();
        return viewer != null ? viewer.isTextSearchActive() : searchActive;
    }

    /**
     * The query field and the previous/next controls are the viewer's own, so
     * search stays exactly as native as the password prompt. If the viewer will
     * not enter search, that is said once and the document stays open.
     */
    private void setSearchActive(boolean active) {
        PdfViewerFragment viewer = viewer();
        if (viewer == null) {
            // No viewer yet: preparing, or failed. Closing search is still a real
            // answer, so the cache that stands in for the viewer is cleared here.
            // Otherwise a restored "search was open" would swallow every Back.
            // Opening search has nothing to open, so the cache is left for the
            // viewer to honour when it arrives.
            if (!active) searchActive = false;
            return;
        }
        viewer.setTextSearchActive(active);
        boolean applied = viewer.isTextSearchActive();
        if (active && !applied) {
            searchActive = false;
            showMessage(R.string.pdf_reader_search_unavailable);
            return;
        }
        searchActive = applied;
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
    protected void onResume() {
        super.onResume();
        hideToolbox();
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putInt(STATE_PAGE, currentPage);
        outState.putBoolean(STATE_SEARCH, isSearchActive());
        outState.putBoolean(STATE_FAILED, failed);
    }

    @Override
    public Object onRetainCustomNonConfigurationInstance() {
        // The staged snapshot outlives this instance, so the next one attaches a
        // fresh fragment to the same session instead of copying the file again.
        return session == null ? null : new RetainedSession(session);
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacks(hideMessage);
        dismissTools();
        if (actions != null) actions.close();
        if (executor != null) executor.shutdownNow();
        // A retained session belongs to the next instance. Only a real teardown
        // closes it, and close is idempotent by contract.
        if (!isChangingConfigurations()) closeSession();
        session = null;
        pdfView = null;
        super.onDestroy();
    }

    /* ------------------------------------------------------------ fragment -- */

    /** The stock viewer with its toolbox hidden and its page position reported back. */
    public static final class ReaderFragment extends PdfViewerFragment {

        @Nullable
        private PdfReaderActivity host() {
            return getActivity() instanceof PdfReaderActivity ? (PdfReaderActivity) getActivity() : null;
        }

        @Override
        public void onLoadDocumentSuccess(@NonNull PdfDocument document) {
            super.onLoadDocumentSuccess(document);
            PdfReaderActivity host = host();
            if (host != null) host.onDocumentLoaded(document.getPageCount());
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
            setToolboxVisible(false);
            pdfView.addOnViewportChangedListener(new PdfView.OnViewportChangedListener() {
                @Override
                public void onViewportChanged(
                        int firstVisiblePage,
                        int visiblePagesCount,
                        @NonNull SparseArray<RectF> visiblePageAreas,
                        float zoomLevel) {
                    PdfReaderActivity host = host();
                    if (host != null) host.onPageChanged(firstVisiblePage);
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
