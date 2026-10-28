package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reviews;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.reviews.PlayInAppReviewPolicy.State;
import org.junit.Test;

public final class PlayInAppReviewPolicyTest {
    private static State savedOn(State state, long... days) {
        for (long day : days) state = state.afterSave(day);
        return state;
    }

    @Test
    public void asksOnlyAfterFiveSavesOnThreeDifferentDays() {
        State fourSaves = savedOn(State.NONE, 1, 1, 2, 3);
        assertFalse(fourSaves.readyToAsk());
        assertTrue(savedOn(fourSaves, 3).readyToAsk());
        assertFalse(savedOn(State.NONE, 5, 5, 5, 5, 5, 5, 5, 5).readyToAsk());
    }

    @Test
    public void asksOnlyOnce() {
        State asked = savedOn(State.NONE, 1, 2, 3, 3, 3).afterAsk();
        assertFalse(asked.readyToAsk());
        assertFalse(savedOn(asked, 4, 5, 6, 6, 6).readyToAsk());
        assertFalse(savedOn(asked, 400, 800, 1200, 1600, 2000).readyToAsk());
    }
}
