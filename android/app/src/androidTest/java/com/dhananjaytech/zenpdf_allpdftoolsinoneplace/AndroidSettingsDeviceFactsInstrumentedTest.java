package com.dhananjaytech.zenpdf_allpdftoolsinoneplace;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.os.Build;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.Set;
import java.util.HashSet;
import java.util.Iterator;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Disposable-emulator proof for the two public device facts used by Settings. */
@RunWith(AndroidJUnit4.class)
public final class AndroidSettingsDeviceFactsInstrumentedTest {
    private static final long TIMEOUT_SECONDS = 20;
    private static final AtomicInteger CALL_SEQUENCE = new AtomicInteger();

    @Test public void registeredDeviceFactsAreExactPublicAndNonLeaking() throws Exception {
        String serial = InstrumentationRegistry.getArguments().getString("serial", "");
        assertTrue("explicit emulator serial required", serial.matches("emulator-[0-9]+"));
        String identity = (Build.FINGERPRINT + " " + Build.MODEL + " " + Build.HARDWARE)
                .toLowerCase(java.util.Locale.ROOT);
        assertTrue("emulator identity required", identity.contains("emulator")
                || identity.contains("generic") || identity.contains("sdk_gphone")
                || identity.contains("ranchu") || identity.contains("goldfish"));

        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        PackageInfo packageInfo = context.getPackageManager().getPackageInfo(
                context.getPackageName(), 0);
        String expectedBuild = Long.toString(Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? packageInfo.getLongVersionCode() : packageInfo.versionCode);

        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                assertNotNull(activity.getBridge().getPlugin("AndroidAppMetadata"));
                assertNotNull(activity.getBridge().getPlugin("AndroidStorageStats"));
            });

            JSONObject discovery = bridgeValue(scenario,
                    "({metadata:Capacitor.isPluginAvailable('AndroidAppMetadata'),"
                    + "storage:Capacitor.isPluginAvailable('AndroidStorageStats'),"
                    + "getMetadata:typeof Capacitor.Plugins.AndroidAppMetadata.getMetadata,"
                    + "getStorageStats:typeof Capacitor.Plugins.AndroidStorageStats.getStorageStats})");
            assertTrue(discovery.getBoolean("metadata"));
            assertTrue(discovery.getBoolean("storage"));
            assertEquals("function", discovery.getString("getMetadata"));
            assertEquals("function", discovery.getString("getStorageStats"));

            JSONObject metadata = bridgeValue(scenario,
                    "Capacitor.Plugins.AndroidAppMetadata.getMetadata({})");
            assertExactKeys(metadata, Set.of("name", "version", "build"));
            assertFalse(metadata.getString("name").isBlank());
            assertEquals(packageInfo.versionName, metadata.getString("version"));
            assertEquals(expectedBuild, metadata.getString("build"));

            JSONObject storage = bridgeValue(scenario,
                    "Capacitor.Plugins.AndroidStorageStats.getStorageStats({})");
            assertExactKeys(storage, Set.of("retainedBytes", "availableBytes", "capacityBytes",
                    "memoryBytes"));
            assertEquals("fresh debug package owned bytes", 0, storage.getLong("retainedBytes"));
            if (!storage.isNull("availableBytes") && !storage.isNull("capacityBytes")) {
                assertTrue(storage.getLong("availableBytes") <= storage.getLong("capacityBytes"));
            }

            JSONObject metadataInvalid = bridgeEnvelope(scenario,
                    "Capacitor.Plugins.AndroidAppMetadata.getMetadata({path:'/private'})");
            assertFalse(metadataInvalid.getBoolean("ok"));
            assertEquals("APP_METADATA_INVALID_ARGUMENT", metadataInvalid.getString("code"));
            JSONObject storageInvalid = bridgeEnvelope(scenario,
                    "Capacitor.Plugins.AndroidStorageStats.getStorageStats({path:'/private'})");
            assertFalse(storageInvalid.getBoolean("ok"));
            assertEquals("STORAGE_STATS_INVALID_ARGUMENT", storageInvalid.getString("code"));

            String publicOutput = metadata.toString() + storage.toString();
            assertFalse(publicOutput.contains("/data/"));
            assertFalse(publicOutput.contains("content://"));
            assertFalse(publicOutput.contains("file://"));
            assertFalse(publicOutput.contains("pdfchef_documents"));

            evaluate(scenario,
                    "history.pushState({},'', '/settings');"
                    + "dispatchEvent(new PopStateEvent('popstate'));true");
            String expectedVersionLabel = "Version " + packageInfo.versionName
                    + " (" + expectedBuild + ")";
            waitFor(scenario, "document.body.innerText.includes("
                    + JSONObject.quote(expectedVersionLabel) + ")");
            waitFor(scenario, "document.body.innerText.includes('0 bytes used')");
            String body = javascriptString(scenario, "document.body.innerText");
            assertTrue(body.contains("Settings stay on this device and do not sync."));
            assertTrue(body.contains(expectedVersionLabel));
            assertTrue(body.contains("0 bytes used"));
            assertFalse(body.contains("Reading version…"));
            assertFalse(body.contains("Version information is unavailable."));
            assertFalse(body.contains("Storage usage could not be read."));
            int width = Integer.parseInt(javascriptString(scenario, "String(innerWidth)"));
            int height = Integer.parseInt(javascriptString(scenario, "String(innerHeight)"));
            assertTrue("normal-phone CSS width", width >= 360 && width <= 430);
            assertTrue("normal-phone CSS height: " + height,
                    height >= 720 && height <= 960);
        }
    }

    private static void assertExactKeys(JSONObject value, Set<String> expected) {
        HashSet<String> actual = new HashSet<>();
        Iterator<String> keys = value.keys();
        while (keys.hasNext()) actual.add(keys.next());
        assertEquals(expected, actual);
    }

    private static JSONObject bridgeValue(ActivityScenario<MainActivity> scenario, String expression)
            throws Exception {
        JSONObject envelope = bridgeEnvelope(scenario, expression);
        assertTrue("bridge invocation: " + envelope, envelope.optBoolean("ok", false));
        return envelope.getJSONObject("value");
    }

    private static JSONObject bridgeEnvelope(ActivityScenario<MainActivity> scenario,
            String expression) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(TIMEOUT_SECONDS);
        while (System.nanoTime() < deadline
                && !"true".equals(evaluate(scenario, "Boolean(window.Capacitor)"))) {
            Thread.sleep(50);
        }
        assertEquals("true", evaluate(scenario, "Boolean(window.Capacitor)"));
        String slot = "__pdfChefT907Facts" + CALL_SEQUENCE.incrementAndGet();
        evaluate(scenario, "window['" + slot + "']=null;(async()=>{try{const value=await ("
                + expression + ");window['" + slot
                + "']=JSON.stringify({ok:true,value});}catch(error){window['" + slot
                + "']=JSON.stringify({ok:false,code:error&&error.code,message:error&&error.message});}})();true");
        String result = null;
        while (System.nanoTime() < deadline) {
            result = evaluate(scenario, "window['" + slot + "']");
            if (!"null".equals(result)) break;
            Thread.sleep(50);
        }
        assertTrue("WebView bridge result slot", result != null && !"null".equals(result));
        return new JSONObject(new JSONArray("[" + result + "]").getString(0));
    }

    private static void waitFor(ActivityScenario<MainActivity> scenario, String expression)
            throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(TIMEOUT_SECONDS);
        while (System.nanoTime() < deadline) {
            if ("true".equals(evaluate(scenario, "Boolean(" + expression + ")"))) return;
            Thread.sleep(50);
        }
        throw new AssertionError("Timed out waiting for " + expression);
    }

    private static String javascriptString(ActivityScenario<MainActivity> scenario,
            String expression) throws Exception {
        return new JSONArray("[" + evaluate(scenario, expression) + "]").getString(0);
    }

    private static String evaluate(ActivityScenario<MainActivity> scenario, String script)
            throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        String[] result = new String[1];
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(
                script, value -> { result[0] = value; latch.countDown(); }));
        assertTrue(latch.await(TIMEOUT_SECONDS, TimeUnit.SECONDS));
        return result[0];
    }
}
