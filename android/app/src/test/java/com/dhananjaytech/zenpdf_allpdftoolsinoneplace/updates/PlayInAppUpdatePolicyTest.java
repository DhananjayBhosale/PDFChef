package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.updates;

import static org.junit.Assert.assertEquals;
import com.google.android.play.core.install.model.InstallStatus;
import com.google.android.play.core.install.model.UpdateAvailability;
import org.junit.Test;

public final class PlayInAppUpdatePolicyTest {
    @Test
    public void startsOneFlexibleFlowForAvailableUpdate() {
        assertEquals(PlayInAppUpdatePolicy.Action.START_FLEXIBLE,
                PlayInAppUpdatePolicy.decide(
                        UpdateAvailability.UPDATE_AVAILABLE, InstallStatus.UNKNOWN, true, false));
        assertEquals(PlayInAppUpdatePolicy.Action.NONE,
                PlayInAppUpdatePolicy.decide(
                        UpdateAvailability.UPDATE_AVAILABLE, InstallStatus.UNKNOWN, true, true));
    }

    @Test
    public void offersRestartAfterDownload() {
        assertEquals(PlayInAppUpdatePolicy.Action.OFFER_RESTART,
                PlayInAppUpdatePolicy.decide(
                        UpdateAvailability.UPDATE_NOT_AVAILABLE, InstallStatus.DOWNLOADED, false, true));
    }

    @Test
    public void ignoresUnavailableOrDisallowedUpdate() {
        assertEquals(PlayInAppUpdatePolicy.Action.NONE,
                PlayInAppUpdatePolicy.decide(
                        UpdateAvailability.UPDATE_NOT_AVAILABLE, InstallStatus.UNKNOWN, true, false));
        assertEquals(PlayInAppUpdatePolicy.Action.NONE,
                PlayInAppUpdatePolicy.decide(
                        UpdateAvailability.UPDATE_AVAILABLE, InstallStatus.PENDING, false, false));
        assertEquals(PlayInAppUpdatePolicy.Action.NONE,
                PlayInAppUpdatePolicy.decide(
                        UpdateAvailability.UPDATE_AVAILABLE, InstallStatus.DOWNLOADING, true, false));
    }
}
