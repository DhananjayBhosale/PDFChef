package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.updates;

import com.google.android.play.core.install.model.InstallStatus;
import com.google.android.play.core.install.model.UpdateAvailability;

/** Pure decision boundary for the user-respectful flexible Play update flow. */
final class PlayInAppUpdatePolicy {
    enum Action {
        NONE,
        START_FLEXIBLE,
        OFFER_RESTART
    }

    private PlayInAppUpdatePolicy() {}

    static Action decide(
            int updateAvailability,
            int installStatus,
            boolean flexibleAllowed,
            boolean flowAlreadyRequested) {
        if (installStatus == InstallStatus.DOWNLOADED) return Action.OFFER_RESTART;
        if (!flowAlreadyRequested
                && installStatus == InstallStatus.UNKNOWN
                && updateAvailability == UpdateAvailability.UPDATE_AVAILABLE
                && flexibleAllowed) {
            return Action.START_FLEXIBLE;
        }
        return Action.NONE;
    }
}
