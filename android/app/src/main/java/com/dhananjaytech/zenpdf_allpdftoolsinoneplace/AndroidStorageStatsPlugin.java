package com.dhananjaytech.zenpdf_allpdftoolsinoneplace;

import android.app.ActivityManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/** Inactive storage-statistics bridge; registration is deliberately owned by a later gate. */
@CapacitorPlugin(name = "AndroidStorageStats")
public final class AndroidStorageStatsPlugin extends Plugin {
    @PluginMethod
    public void getStorageStats(PluginCall call) {
        JSObject request = call.getData();
        if (request == null || request.length() != 0) {
            call.reject("The storage stats request is invalid.", "STORAGE_STATS_INVALID_ARGUMENT");
            return;
        }
        try {
            AndroidStorageStatsCalculator.StorageStats stats = new AndroidStorageStatsCalculator()
                    .calculate(getContext().getFilesDir().toPath());
            JSObject output = new JSObject();
            output.put("retainedBytes", stats.retainedBytes());
            output.put("availableBytes", stats.availableBytes());
            output.put("capacityBytes", stats.capacityBytes());
            output.put("memoryBytes", totalMemory());
            call.resolve(output);
        } catch (Exception ignored) {
            call.reject("Storage statistics are unavailable.", "STORAGE_STATS_FAILED");
        }
    }

    /** Total RAM, so the app can size photos to suit the phone; null when Android does not say. */
    private Object totalMemory() {
        ActivityManager activities = getContext().getSystemService(ActivityManager.class);
        if (activities == null) return JSONObject.NULL;
        ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
        activities.getMemoryInfo(memory);
        return memory.totalMem > 0 ? memory.totalMem : JSONObject.NULL;
    }
}
