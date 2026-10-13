package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import android.content.Context;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;

import androidx.annotation.Nullable;

import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.R;

import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.Date;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** Marks the immutable snapshot in memory and streams the copy to Android's spooler; never creates an unlocked cache file. */
final class PdfVerifiedCopyPrintAdapter extends PrintDocumentAdapter {
    private final Context context;
    private final PdfVerifiedCopy.Result copy;
    private final String displayName;
    @Nullable private final char[] password;
    private final Date checkedAt;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean finished;

    PdfVerifiedCopyPrintAdapter(Context context, PdfVerifiedCopy.Result copy, @Nullable char[] password,
            Date checkedAt, String displayName) {
        this.context = context.getApplicationContext();
        this.checkedAt = checkedAt;
        this.copy = copy;
        this.displayName = displayName;
        this.password = password == null ? null : password.clone();
    }

    @Override public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes,
            CancellationSignal cancellation, LayoutResultCallback callback, Bundle extras) {
        if (finished || cancellation.isCanceled()) {
            callback.onLayoutCancelled();
            return;
        }
        callback.onLayoutFinished(new PrintDocumentInfo.Builder(displayName)
                .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                .setPageCount(copy.pageCount).build(), !newAttributes.equals(oldAttributes));
    }

    @Override public void onWrite(PageRange[] pages, ParcelFileDescriptor destination,
            CancellationSignal cancellation, WriteResultCallback callback) {
        try {
            worker.execute(() -> {
                try (OutputStream output = PdfVerifiedCopy.boundedOutput(new FilterOutputStream(
                        new ParcelFileDescriptor.AutoCloseOutputStream(destination)) {
                    @Override public void write(int value) throws IOException {
                        checkCancelled(cancellation);
                        out.write(value);
                    }
                    @Override public void write(byte[] bytes, int offset, int length) throws IOException {
                        checkCancelled(cancellation);
                        out.write(bytes, offset, length);
                    }
                })) {
                    checkCancelled(cancellation);
                    PdfVerifiedCopy.writeForPrint(copy.path, password, checkedAt, output);
                } catch (Exception failure) {
                    main.post(() -> {
                        if (finished || cancellation.isCanceled()) callback.onWriteCancelled();
                        else callback.onWriteFailed(context.getString(R.string.pdf_reader_verified_copy_failed));
                    });
                    return;
                }
                main.post(() -> {
                    if (finished || cancellation.isCanceled()) callback.onWriteCancelled();
                    else callback.onWriteFinished(new PageRange[] {PageRange.ALL_PAGES});
                });
            });
        } catch (RejectedExecutionException unavailable) {
            try { destination.close(); } catch (IOException ignored) { }
            callback.onWriteCancelled();
        }
    }

    private void checkCancelled(CancellationSignal cancellation) throws IOException {
        if (finished || cancellation.isCanceled() || Thread.currentThread().isInterrupted()) {
            throw new IOException("Printing cancelled");
        }
    }

    @Override public void onFinish() {
        finished = true;
        worker.shutdownNow();
        if (password != null) Arrays.fill(password, '\0');
    }
}
