package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.updates;

import android.app.Activity;
import android.app.AlertDialog;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import com.dhananjaytech.zenpdf_allpdftoolsinoneplace.R;
import com.google.android.play.core.appupdate.AppUpdateManager;
import com.google.android.play.core.appupdate.AppUpdateManagerFactory;
import com.google.android.play.core.appupdate.AppUpdateOptions;
import com.google.android.play.core.install.InstallState;
import com.google.android.play.core.install.InstallStateUpdatedListener;
import com.google.android.play.core.install.model.AppUpdateType;
import com.google.android.play.core.install.model.InstallStatus;

/** Owns Google Play's flexible in-app update lifecycle for the main Activity. */
public final class PlayInAppUpdateController implements InstallStateUpdatedListener {
    private final Activity activity;
    private final ActivityResultLauncher<IntentSenderRequest> launcher;
    private final AppUpdateManager manager;
    private boolean checking;
    private boolean flowRequested;
    private boolean closed;
    private AlertDialog restartDialog;

    private PlayInAppUpdateController(
            Activity activity,
            ActivityResultLauncher<IntentSenderRequest> launcher,
            AppUpdateManager manager) {
        this.activity = activity;
        this.launcher = launcher;
        this.manager = manager;
        manager.registerListener(this);
    }

    public static PlayInAppUpdateController create(
            Activity activity,
            ActivityResultLauncher<IntentSenderRequest> launcher) {
        return new PlayInAppUpdateController(
                activity,
                launcher,
                AppUpdateManagerFactory.create(activity.getApplicationContext()));
    }

    public void checkForUpdate() {
        if (closed || checking) return;
        checking = true;
        manager.getAppUpdateInfo()
                .addOnSuccessListener(info -> {
                    checking = false;
                    if (closed) return;
                    switch (PlayInAppUpdatePolicy.decide(
                            info.updateAvailability(),
                            info.installStatus(),
                            info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE),
                            flowRequested)) {
                        case OFFER_RESTART -> offerRestart();
                        case START_FLEXIBLE -> {
                            flowRequested = true;
                            try {
                                manager.startUpdateFlowForResult(
                                        info,
                                        launcher,
                                        AppUpdateOptions.newBuilder(AppUpdateType.FLEXIBLE).build());
                            } catch (RuntimeException ignored) {
                                // Play may be absent, outdated, or unable to own the flow.
                                // Normal Play Store updates remain available.
                            }
                        }
                        case NONE -> { }
                    }
                })
                .addOnFailureListener(ignored -> checking = false);
    }

    public void onUpdateFlowResult(int resultCode) {
        // Cancellation is deliberately non-fatal. Do not repeatedly prompt during
        // this Activity session; Play Store auto/manual updates remain available.
        if (resultCode == Activity.RESULT_OK) checkForUpdate();
    }

    @Override
    public void onStateUpdate(InstallState state) {
        if (closed) return;
        if (state.installStatus() == InstallStatus.DOWNLOADED) offerRestart();
        if (state.installStatus() == InstallStatus.INSTALLED) dismissRestartDialog();
    }

    private void offerRestart() {
        if (closed || activity.isFinishing() || activity.isDestroyed()
                || (restartDialog != null && restartDialog.isShowing())) return;
        restartDialog = new AlertDialog.Builder(activity)
                .setTitle(R.string.update_ready_title)
                .setMessage(R.string.update_ready_message)
                .setNegativeButton(R.string.update_later, null)
                .setPositiveButton(R.string.update_restart, (dialog, which) -> manager.completeUpdate())
                .create();
        restartDialog.show();
    }

    private void dismissRestartDialog() {
        if (restartDialog != null) {
            restartDialog.dismiss();
            restartDialog = null;
        }
    }

    public void close() {
        if (closed) return;
        closed = true;
        manager.unregisterListener(this);
        dismissRestartDialog();
    }
}
