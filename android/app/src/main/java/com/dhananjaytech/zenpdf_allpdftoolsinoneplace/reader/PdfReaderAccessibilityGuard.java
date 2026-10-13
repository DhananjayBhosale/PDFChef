package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reader;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityNodeProvider;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.Collections;
import java.util.List;

/**
 * Preserves AndroidX PDF accessibility while containing invalid transient virtual nodes.
 *
 * The beta viewer can leave a link/form virtual id visible for one accessibility request after its
 * bounds disappear. ExploreByTouchHelper then throws from createNodeForChild. Wrapping the provider
 * lets that one stale node resolve as absent while every valid page, link, form and action continues
 * through the original provider unchanged.
 */
final class PdfReaderAccessibilityGuard {
    private PdfReaderAccessibilityGuard() { }

    static void install(@NonNull View view) {
        if (Build.VERSION.SDK_INT < 29) return;
        View.AccessibilityDelegate original = view.getAccessibilityDelegate();
        if (original == null || original instanceof GuardedDelegate) return;
        view.setAccessibilityDelegate(new GuardedDelegate(original));
    }

    private static final class GuardedDelegate extends View.AccessibilityDelegate {
        private final View.AccessibilityDelegate delegate;

        GuardedDelegate(View.AccessibilityDelegate delegate) {
            this.delegate = delegate;
        }

        @Override public boolean dispatchPopulateAccessibilityEvent(
                @NonNull View host, @NonNull AccessibilityEvent event) {
            return PdfReaderRuntimeGuard.value(
                    () -> delegate.dispatchPopulateAccessibilityEvent(host, event), false);
        }

        @Override public void onInitializeAccessibilityEvent(
                @NonNull View host, @NonNull AccessibilityEvent event) {
            PdfReaderRuntimeGuard.action(() -> delegate.onInitializeAccessibilityEvent(host, event));
        }

        @Override public void onInitializeAccessibilityNodeInfo(
                @NonNull View host, @NonNull AccessibilityNodeInfo info) {
            PdfReaderRuntimeGuard.action(() -> delegate.onInitializeAccessibilityNodeInfo(host, info));
        }

        @Override public void onPopulateAccessibilityEvent(
                @NonNull View host, @NonNull AccessibilityEvent event) {
            PdfReaderRuntimeGuard.action(() -> delegate.onPopulateAccessibilityEvent(host, event));
        }

        @Override public boolean onRequestSendAccessibilityEvent(
                @NonNull ViewGroup host, @NonNull View child, @NonNull AccessibilityEvent event) {
            return PdfReaderRuntimeGuard.value(
                    () -> delegate.onRequestSendAccessibilityEvent(host, child, event), false);
        }

        @Override public boolean performAccessibilityAction(
                @NonNull View host, int action, @Nullable Bundle args) {
            return PdfReaderRuntimeGuard.value(
                    () -> delegate.performAccessibilityAction(host, action, args), false);
        }

        @Override public void sendAccessibilityEvent(@NonNull View host, int eventType) {
            PdfReaderRuntimeGuard.action(() -> delegate.sendAccessibilityEvent(host, eventType));
        }

        @Override public void sendAccessibilityEventUnchecked(
                @NonNull View host, @NonNull AccessibilityEvent event) {
            PdfReaderRuntimeGuard.action(() -> delegate.sendAccessibilityEventUnchecked(host, event));
        }

        @Nullable
        @Override public AccessibilityNodeProvider getAccessibilityNodeProvider(@NonNull View host) {
            AccessibilityNodeProvider provider = PdfReaderRuntimeGuard.value(
                    () -> delegate.getAccessibilityNodeProvider(host), null);
            return provider == null ? null : new GuardedProvider(provider);
        }

        @Override public void addExtraDataToAccessibilityNodeInfo(@NonNull View host,
                @NonNull AccessibilityNodeInfo info, @NonNull String key,
                @Nullable Bundle args) {
            PdfReaderRuntimeGuard.action(
                    () -> delegate.addExtraDataToAccessibilityNodeInfo(host, info, key, args));
        }
    }

    private static final class GuardedProvider extends AccessibilityNodeProvider {
        private final AccessibilityNodeProvider provider;

        GuardedProvider(AccessibilityNodeProvider provider) {
            this.provider = provider;
        }

        @Nullable
        @Override public AccessibilityNodeInfo createAccessibilityNodeInfo(int virtualViewId) {
            return PdfReaderRuntimeGuard.value(
                    () -> provider.createAccessibilityNodeInfo(virtualViewId), null);
        }

        @NonNull
        @Override public List<AccessibilityNodeInfo> findAccessibilityNodeInfosByText(
                @NonNull String text, int virtualViewId) {
            List<AccessibilityNodeInfo> values = PdfReaderRuntimeGuard.value(
                    () -> provider.findAccessibilityNodeInfosByText(text, virtualViewId), null);
            return values == null ? Collections.emptyList() : values;
        }

        @Override public boolean performAction(int virtualViewId, int action, @Nullable Bundle args) {
            return PdfReaderRuntimeGuard.value(
                    () -> provider.performAction(virtualViewId, action, args), false);
        }

        @Nullable
        @Override public AccessibilityNodeInfo findFocus(int focus) {
            return PdfReaderRuntimeGuard.value(() -> provider.findFocus(focus), null);
        }

        @Override public void addExtraDataToAccessibilityNodeInfo(int virtualViewId,
                @NonNull AccessibilityNodeInfo info, @NonNull String key,
                @Nullable Bundle args) {
            PdfReaderRuntimeGuard.action(() -> provider.addExtraDataToAccessibilityNodeInfo(
                    virtualViewId, info, key, args));
        }
    }
}
