package com.dhananjaytech.zenpdf_allpdftoolsinoneplace.security;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class PdfChefWebViewPolicyTest {
    @Test public void acceptsOnlyThePackagedLocalOrigin() {
        assertEquals(PdfChefWebViewPolicy.Navigation.ALLOW_PACKAGED_ORIGIN,
                PdfChefWebViewPolicy.decide("https://localhost/"));
        assertEquals(PdfChefWebViewPolicy.Navigation.ALLOW_PACKAGED_ORIGIN,
                PdfChefWebViewPolicy.decide("https://localhost/tools?source=home#top"));

        for (String blocked : new String[] {
                "https://localhost.evil.example/", "https://localhost:8443/", "http://localhost/",
                "https://user@localhost/", "file:///android_asset/index.html", "content://provider/item",
                "intent://open/#Intent;scheme=https;end", "javascript:alert(1)", "data:text/html,x",
                "blob:https://localhost/id", "https://localhost\\@evil.example/", "not a url"
        }) {
            assertEquals(blocked, PdfChefWebViewPolicy.Navigation.BLOCK,
                    PdfChefWebViewPolicy.decide(blocked));
        }
    }

    @Test public void keepsExistingWebAndEmailLinksVisibleOutsideTheBridge() {
        assertEquals(PdfChefWebViewPolicy.Navigation.OPEN_EXTERNAL_BROWSER,
                PdfChefWebViewPolicy.decide("https://www.example.com/help"));
        assertEquals(PdfChefWebViewPolicy.Navigation.OPEN_EXTERNAL_BROWSER,
                PdfChefWebViewPolicy.decide("http://www.example.com/legacy"));
        assertEquals(PdfChefWebViewPolicy.Navigation.OPEN_EXTERNAL_BROWSER,
                PdfChefWebViewPolicy.decide("mailto:support@example.com"));
        assertEquals(PdfChefWebViewPolicy.Navigation.BLOCK,
                PdfChefWebViewPolicy.decide("mailto:support@example.com%0d%0aBcc:attacker@example.com"));
        assertEquals(PdfChefWebViewPolicy.Navigation.BLOCK,
                PdfChefWebViewPolicy.decide("tel:+123456789"));
        assertEquals(PdfChefWebViewPolicy.Navigation.BLOCK,
                PdfChefWebViewPolicy.decide("https://user@example.com/"));
    }

    @Test public void reloadsTheSamePackagedRouteWithTheRecoveryMarkerOnly() {
        assertEquals("https://localhost/compress#renderer-restarted",
                PdfChefWebViewPolicy.rendererRecoveryUrl("https://localhost/compress"));
        assertEquals("https://localhost/view?x=1#renderer-restarted",
                PdfChefWebViewPolicy.rendererRecoveryUrl("https://localhost/view?x=1#/old"));
        assertEquals(null, PdfChefWebViewPolicy.rendererRecoveryUrl(null));
        assertEquals(null, PdfChefWebViewPolicy.rendererRecoveryUrl("https://www.example.com/"));
    }

    @Test public void isolatesOnlyTheObservedBrokenGraphicsDriver() {
        assertTrue(PdfChefWebViewPolicy.requiresSoftwareRendering("mt6855", ""));
        assertTrue(PdfChefWebViewPolicy.requiresSoftwareRendering("other", "MT6855"));
        assertFalse(PdfChefWebViewPolicy.requiresSoftwareRendering("mt6985", "Dimensity 9300"));
        assertFalse(PdfChefWebViewPolicy.requiresSoftwareRendering(null, null));
    }

    @Test public void rendererRecoveryCannotLoopImmediately() {
        assertTrue(PdfChefWebViewPolicy.mayRestartRenderer(0, 10));
        assertFalse(PdfChefWebViewPolicy.mayRestartRenderer(10,
                10 + PdfChefWebViewPolicy.RENDERER_RECOVERY_COOLDOWN_MILLIS - 1));
        assertTrue(PdfChefWebViewPolicy.mayRestartRenderer(10,
                10 + PdfChefWebViewPolicy.RENDERER_RECOVERY_COOLDOWN_MILLIS));
    }
}
