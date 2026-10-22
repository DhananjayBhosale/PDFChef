package com.dhananjaytech.zenpdf_allpdftoolsinoneplace;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import org.json.JSONObject;

/**
 * Optional support through Google Play. Nothing in the app depends on it: every tool stays free
 * for everyone, and a support payment unlocks nothing. Until both products exist in Play Console
 * the state is "unavailable" and the app shows no support at all.
 */
@CapacitorPlugin(name = "AndroidSupport")
public final class AndroidSupportPlugin extends Plugin implements PurchasesUpdatedListener {
    static final String MONTHLY_PRODUCT_ID = "supporter_monthly";
    static final String MONTHLY_BASE_PLAN_ID = "monthly";
    static final String LIFETIME_PRODUCT_ID = "supporter_lifetime";
    private static final long CONNECT_TIMEOUT_MS = 15_000;

    private BillingClient billing;
    private boolean connecting;
    private final List<Waiting> waiting = new ArrayList<>();
    private ProductDetails monthly;
    private ProductDetails lifetime;
    private PluginCall purchaseCall;
    private final Handler main = new Handler(Looper.getMainLooper());

    private static final class Waiting {
        final PluginCall call;
        final Runnable ready;

        Waiting(PluginCall call, Runnable ready) {
            this.call = call;
            this.ready = ready;
        }
    }

    @PluginMethod
    public void getSupport(PluginCall call) {
        JSObject data = call.getData();
        if (data == null || data.length() != 0) {
            call.reject("The support request is invalid.", "SUPPORT_INVALID_ARGUMENT");
            return;
        }
        connect(call, () -> loadProducts(() -> queryOwned(BillingClient.ProductType.INAPP,
                once -> queryOwned(BillingClient.ProductType.SUBS,
                        subscriptions -> call.resolve(state(once, subscriptions))))));
    }

    @PluginMethod
    public void support(PluginCall call) {
        JSObject data = call.getData();
        String plan = data == null || data.length() != 1 ? null : data.getString("plan");
        if (!"monthly".equals(plan) && !"lifetime".equals(plan)) {
            call.reject("The support request is invalid.", "SUPPORT_INVALID_ARGUMENT");
            return;
        }
        synchronized (this) {
            if (purchaseCall != null) {
                call.reject("A support payment is already open.", "SUPPORT_BUSY");
                return;
            }
            purchaseCall = call;
        }
        connect(call, () -> {
            if (detailsFor(plan) != null) launch(plan);
            else loadProducts(() -> launch(plan));
        });
    }

    @PluginMethod
    public void manageSupport(PluginCall call) {
        JSObject data = call.getData();
        if (data == null || data.length() != 0) {
            call.reject("The support request is invalid.", "SUPPORT_INVALID_ARGUMENT");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(
                "https://play.google.com/store/account/subscriptions?sku=" + MONTHLY_PRODUCT_ID
                        + "&package=" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            JSObject output = new JSObject();
            output.put("status", "opened");
            call.resolve(output);
        } catch (ActivityNotFoundException ignored) {
            call.reject("Google Play is unavailable.", "SUPPORT_UNAVAILABLE");
        }
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (this) {
            main.removeCallbacksAndMessages(null);
            if (billing != null) billing.endConnection();
            billing = null;
        }
    }

    private void connect(PluginCall call, Runnable ready) {
        BillingClient client;
        synchronized (this) {
            if (billing == null) {
                billing = BillingClient.newBuilder(getContext())
                        .setListener(this)
                        .enablePendingPurchases(PendingPurchasesParams.newBuilder()
                                .enableOneTimeProducts().build())
                        .build();
            }
            client = billing;
            if (!client.isReady()) {
                waiting.add(new Waiting(call, ready));
                if (connecting) return;
                connecting = true;
            }
        }
        if (client.isReady()) {
            ready.run();
            return;
        }
        // Without a usable Google Play the library may never answer, so the wait is bounded.
        main.postDelayed(() -> finishConnecting(client, false), CONNECT_TIMEOUT_MS);
        client.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(BillingResult result) {
                finishConnecting(client,
                        result.getResponseCode() == BillingClient.BillingResponseCode.OK);
            }

            @Override
            public void onBillingServiceDisconnected() {
                finishConnecting(client, false);
            }
        });
    }

    /** Only the first answer for the current client counts; a failed client is replaced next time. */
    private void finishConnecting(BillingClient client, boolean ready) {
        List<Waiting> due;
        synchronized (this) {
            if (client != billing || !connecting) return;
            connecting = false;
            main.removeCallbacksAndMessages(null);
            due = new ArrayList<>(waiting);
            waiting.clear();
            if (!ready) {
                client.endConnection();
                billing = null;
            }
        }
        for (Waiting next : due) {
            if (ready) next.ready.run();
            else unavailable(next.call);
        }
    }

    private void loadProducts(Runnable done) {
        queryDetails(LIFETIME_PRODUCT_ID, BillingClient.ProductType.INAPP, onceDetails -> {
            lifetime = onceDetails;
            queryDetails(MONTHLY_PRODUCT_ID, BillingClient.ProductType.SUBS, monthlyDetails -> {
                monthly = monthlyDetails;
                done.run();
            });
        });
    }

    private void queryDetails(String productId, String type, Consumer<ProductDetails> done) {
        BillingClient client = billing;
        if (client == null) {
            done.accept(null);
            return;
        }
        QueryProductDetailsParams.Product product = QueryProductDetailsParams.Product.newBuilder()
                .setProductId(productId)
                .setProductType(type)
                .build();
        client.queryProductDetailsAsync(
                QueryProductDetailsParams.newBuilder().setProductList(List.of(product)).build(),
                (result, details) -> {
                    ProductDetails found = null;
                    if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                        for (ProductDetails item : details.getProductDetailsList()) {
                            if (productId.equals(item.getProductId())) found = item;
                        }
                    }
                    done.accept(found);
                });
    }

    private void queryOwned(String type, Consumer<List<Purchase>> done) {
        BillingClient client = billing;
        if (client == null) {
            done.accept(List.of());
            return;
        }
        client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(type).build(),
                (result, purchases) -> done.accept(
                        result.getResponseCode() == BillingClient.BillingResponseCode.OK
                                ? purchases : List.of()));
    }

    private JSObject state(List<Purchase> once, List<Purchase> subscriptions) {
        String lifetimePrice = lifetimePrice();
        String monthlyPrice = monthlyPrice();
        String supporter = "none";
        boolean pending = false;
        List<Purchase> all = new ArrayList<>(subscriptions);
        all.addAll(once);
        for (Purchase purchase : all) {
            boolean ours = purchase.getProducts().contains(LIFETIME_PRODUCT_ID)
                    || purchase.getProducts().contains(MONTHLY_PRODUCT_ID);
            if (!ours) continue;
            if (purchase.getPurchaseState() == Purchase.PurchaseState.PENDING) pending = true;
            if (purchase.getPurchaseState() != Purchase.PurchaseState.PURCHASED) continue;
            acknowledge(purchase);
            if (purchase.getProducts().contains(LIFETIME_PRODUCT_ID)) supporter = "lifetime";
            else if (!"lifetime".equals(supporter)) supporter = "monthly";
        }
        JSObject output = new JSObject();
        output.put("status", lifetimePrice != null || monthlyPrice != null ? "ready" : "unavailable");
        output.put("monthlyPrice", monthlyPrice == null ? JSONObject.NULL : monthlyPrice);
        output.put("lifetimePrice", lifetimePrice == null ? JSONObject.NULL : lifetimePrice);
        output.put("supporter", supporter);
        output.put("pending", pending);
        return output;
    }

    private String lifetimePrice() {
        ProductDetails.OneTimePurchaseOfferDetails offer = lifetime == null ? null
                : lifetime.getOneTimePurchaseOfferDetails();
        return offer == null ? null : offer.getFormattedPrice();
    }

    private ProductDetails.SubscriptionOfferDetails monthlyOffer() {
        if (monthly == null || monthly.getSubscriptionOfferDetails() == null) return null;
        for (ProductDetails.SubscriptionOfferDetails offer : monthly.getSubscriptionOfferDetails()) {
            if (MONTHLY_BASE_PLAN_ID.equals(offer.getBasePlanId()) && offer.getOfferId() == null) {
                return offer;
            }
        }
        return null;
    }

    private String monthlyPrice() {
        ProductDetails.SubscriptionOfferDetails offer = monthlyOffer();
        if (offer == null) return null;
        List<ProductDetails.PricingPhase> phases = offer.getPricingPhases().getPricingPhaseList();
        return phases.isEmpty() ? null : phases.get(phases.size() - 1).getFormattedPrice();
    }

    private ProductDetails detailsFor(String plan) {
        return "monthly".equals(plan) ? (monthlyOffer() == null ? null : monthly) : lifetime;
    }

    private void launch(String plan) {
        ProductDetails details = detailsFor(plan);
        Activity activity = getActivity();
        BillingClient client = billing;
        if (details == null || activity == null || client == null) {
            finishPurchase("unavailable");
            return;
        }
        BillingFlowParams.ProductDetailsParams.Builder product =
                BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(details);
        if ("monthly".equals(plan)) product.setOfferToken(monthlyOffer().getOfferToken());
        BillingFlowParams flow = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(List.of(product.build()))
                .build();
        activity.runOnUiThread(() -> {
            int code = client.launchBillingFlow(activity, flow).getResponseCode();
            if (code == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) finishPurchase("supported");
            else if (code != BillingClient.BillingResponseCode.OK) finishPurchase("unavailable");
        });
    }

    @Override
    public void onPurchasesUpdated(BillingResult result, List<Purchase> purchases) {
        int code = result.getResponseCode();
        if (code == BillingClient.BillingResponseCode.USER_CANCELED) {
            finishPurchase("cancelled");
            return;
        }
        if (code == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) {
            finishPurchase("supported");
            return;
        }
        if (code != BillingClient.BillingResponseCode.OK || purchases == null) {
            finishPurchase("unavailable");
            return;
        }
        String status = "unavailable";
        for (Purchase purchase : purchases) {
            if (purchase.getPurchaseState() == Purchase.PurchaseState.PURCHASED) {
                acknowledge(purchase);
                status = "supported";
            } else if (purchase.getPurchaseState() == Purchase.PurchaseState.PENDING
                    && !"supported".equals(status)) {
                status = "pending";
            }
        }
        finishPurchase(status);
    }

    /** Play refunds a purchase that is not acknowledged within three days. */
    private void acknowledge(Purchase purchase) {
        BillingClient client = billing;
        if (client == null || purchase.isAcknowledged()) return;
        client.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder()
                .setPurchaseToken(purchase.getPurchaseToken()).build(), ignored -> {});
    }

    private void finishPurchase(String status) {
        PluginCall call;
        synchronized (this) {
            call = purchaseCall;
            purchaseCall = null;
        }
        if (call == null) return;
        JSObject output = new JSObject();
        output.put("status", status);
        call.resolve(output);
    }

    private void unavailable(PluginCall call) {
        synchronized (this) {
            if (purchaseCall == call) {
                finishPurchase("unavailable");
                return;
            }
        }
        JSObject output = new JSObject();
        output.put("status", "unavailable");
        output.put("monthlyPrice", JSONObject.NULL);
        output.put("lifetimePrice", JSONObject.NULL);
        output.put("supporter", "none");
        output.put("pending", false);
        call.resolve(output);
    }
}
