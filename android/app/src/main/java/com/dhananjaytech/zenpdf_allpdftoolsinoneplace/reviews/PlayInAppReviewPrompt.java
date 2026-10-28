package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reviews;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import androidx.lifecycle.Lifecycle;
import androidx.lifecycle.LifecycleOwner;
import com.google.android.play.core.review.ReviewManager;
import com.google.android.play.core.review.ReviewManagerFactory;
import java.time.LocalDate;

/**
 * Shows Google Play's own rating card to people who keep coming back to save their work.
 * Play decides whether the card really appears and never says what the person chose, so
 * nothing waits on it and a failure changes nothing for the person.
 */
public final class PlayInAppReviewPrompt {
    private static final String PREFERENCES = "pdfchef_play_review";

    private PlayInAppReviewPrompt() {}

    /**
     * Counts a document saved to the device. Call off the main thread; true means ask now.
     * While the app is not in front, a due ask waits for a later save instead of being spent.
     */
    public static synchronized boolean recordSave(Context context, boolean inFront) {
        SharedPreferences preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        if (preferences.getBoolean("asked", false)) return false;
        long today = LocalDate.now().toEpochDay();
        PlayInAppReviewPolicy.State state = new PlayInAppReviewPolicy.State(
                preferences.getInt("saves", 0),
                preferences.getInt("activeDays", 0),
                preferences.getLong("lastSaveDay", Long.MIN_VALUE),
                false).afterSave(today);
        boolean ask = inFront && state.readyToAsk();
        // Counted as asked even when Play shows nothing, so nobody is ever asked twice.
        if (ask) state = state.afterAsk();
        preferences.edit()
                .putInt("saves", state.saves())
                .putInt("activeDays", state.activeDays())
                .putLong("lastSaveDay", state.lastSaveDay())
                .putBoolean("asked", state.asked())
                .commit();
        return ask;
    }

    /** True while the activity is on screen, so the card can never land over another app. */
    public static boolean inFront(Activity activity) {
        return activity instanceof LifecycleOwner owner && !activity.isFinishing()
                && owner.getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED);
    }

    /** Asks Play for its rating card over the app. Call on the main thread. */
    public static void ask(Activity activity) {
        if (!inFront(activity)) return;
        ReviewManager manager = ReviewManagerFactory.create(activity.getApplicationContext());
        manager.requestReviewFlow().addOnSuccessListener(info -> {
            if (!inFront(activity)) return;
            try {
                manager.launchReviewFlow(activity, info);
            } catch (RuntimeException ignored) {
                // Play may be missing or unable to show the card; the save already succeeded.
            }
        });
    }
}
