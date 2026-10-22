package com.dhananjaytech.zenpdf_allpdftoolsinoneplace;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import java.util.TreeSet;
import org.junit.Test;

public final class AndroidSupportPluginContractTest {
    @Test public void pluginExposesOnlyTheThreeSupportMethods() {
        Class<?> type = AndroidSupportPlugin.class;
        CapacitorPlugin annotation = type.getAnnotation(CapacitorPlugin.class);
        assertNotNull(annotation);
        assertEquals("AndroidSupport", annotation.name());
        assertEquals(0, annotation.permissions().length);
        assertTrue(Modifier.isFinal(type.getModifiers()));
        assertEquals(Plugin.class, type.getSuperclass());

        TreeSet<String> exposed = new TreeSet<>();
        for (Method method : type.getDeclaredMethods()) {
            PluginMethod pluginMethod = method.getAnnotation(PluginMethod.class);
            if (pluginMethod == null) continue;
            exposed.add(method.getName());
            assertTrue(Modifier.isPublic(method.getModifiers()));
            assertArrayEquals(new Class<?>[] {PluginCall.class}, method.getParameterTypes());
            assertEquals(PluginMethod.RETURN_PROMISE, pluginMethod.returnType());
        }
        assertEquals(Set.of("getSupport", "support", "manageSupport"), exposed);
    }

    @Test public void productsAndWireMatchPlayConsoleAndTheWebClient() throws Exception {
        assertEquals("supporter", AndroidSupportPlugin.SUBSCRIPTION_PRODUCT_ID);
        assertEquals("monthly", AndroidSupportPlugin.MONTHLY_BASE_PLAN_ID);
        assertEquals("yearly", AndroidSupportPlugin.YEARLY_BASE_PLAN_ID);
        assertEquals("supporter_lifetime", AndroidSupportPlugin.LIFETIME_PRODUCT_ID);

        String source = new String(Files.readAllBytes(Path.of(System.getProperty("user.dir"))
                .resolve("src/main/java/com/dhananjaytech/zenpdf_allpdftoolsinoneplace/"
                        + "AndroidSupportPlugin.java")), StandardCharsets.UTF_8);
        for (String key : new String[] {"status", "monthlyPrice", "yearlyPrice", "lifetimePrice", "supporter", "pending"}) {
            assertTrue(key, source.contains("output.put(\"" + key + "\""));
        }
        // Every purchase is acknowledged, or Google Play refunds it after three days.
        assertTrue(source.contains("acknowledgePurchase("));
        assertTrue(source.contains("enablePendingPurchases("));
        // With auto reconnection the library never answers on a phone without Google Play,
        // and every support call would wait forever.
        assertFalse(source.contains("enableAutoServiceReconnection"));
        assertTrue(source.contains("main.postDelayed(() -> finishConnecting(client, false), CONNECT_TIMEOUT_MS)"));
    }
}
