package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.documents;

import android.content.ContentValues;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import androidx.core.content.FileProvider;
import java.io.FileNotFoundException;
import java.util.List;

/**
 * Narrow FileProvider that refuses every mutation path even when called directly.
 *
 * The one exception is the camera capture root: the device camera app writes the
 * photo Make PDF asked for into it, and nothing else is ever handed out from there.
 */
public final class ReadOnlyDocumentFileProvider extends FileProvider {
    static final String CAPTURE_ROOT = "pdfchef_captures";

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode)
            throws FileNotFoundException {
        if (!"r".equals(mode)) {
            if (!isCapturePath(uri == null ? null : uri.getPathSegments())) {
                throw new SecurityException("Read-only document provider");
            }
        }
        return super.openFile(uri, mode);
    }

    /** Only a file directly inside the capture root may be opened for writing. */
    static boolean isCapturePath(List<String> segments) {
        if (segments == null || segments.size() != 2 || !CAPTURE_ROOT.equals(segments.get(0))) {
            return false;
        }
        String name = segments.get(1);
        return !name.isEmpty() && !".".equals(name) && !"..".equals(name);
    }

    @Override public Uri insert(Uri uri, ContentValues values) {
        throw new SecurityException("Read-only document provider");
    }

    @Override public int update(Uri uri, ContentValues values, String selection,
            String[] selectionArgs) {
        throw new SecurityException("Read-only document provider");
    }

    @Override public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new SecurityException("Read-only document provider");
    }
}
