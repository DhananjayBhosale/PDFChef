package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reviews;

/**
 * When to ask Google Play for its rating card: once, and only to people who have saved work on
 * several different days. No question comes first, because Google's guidelines forbid asking
 * whether someone likes the app before showing the card.
 */
final class PlayInAppReviewPolicy {
    static final int SAVES_BEFORE_ASKING = 5;
    static final int DAYS_BEFORE_ASKING = 3;

    private PlayInAppReviewPolicy() {}

    /** Days are local calendar days. */
    record State(int saves, int activeDays, long lastSaveDay, boolean asked) {
        static final State NONE = new State(0, 0, Long.MIN_VALUE, false);

        State afterSave(long today) {
            return new State(saves + 1, today == lastSaveDay ? activeDays : activeDays + 1,
                    today, asked);
        }

        boolean readyToAsk() {
            return !asked && saves >= SAVES_BEFORE_ASKING && activeDays >= DAYS_BEFORE_ASKING;
        }

        State afterAsk() {
            return new State(saves, activeDays, lastSaveDay, true);
        }
    }
}
