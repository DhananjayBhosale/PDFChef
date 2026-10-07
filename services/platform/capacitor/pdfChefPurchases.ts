import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export const PDF_CHEF_LIFETIME_PRODUCT_ID = 'com.dhananjaytech.pdfchef.pro.lifetime';
export const PDF_CHEF_MONTHLY_PRODUCT_ID = 'com.dhananjaytech.pdfchef.pro.monthly';

export type PdfChefPurchaseKind = 'lifetime' | 'monthly';

export interface PdfChefPurchaseProduct {
  productId: typeof PDF_CHEF_LIFETIME_PRODUCT_ID | typeof PDF_CHEF_MONTHLY_PRODUCT_ID;
  kind: PdfChefPurchaseKind;
  displayName: string;
  description: string;
  /** StoreKit's localized display string. Never infer a currency or price in JavaScript. */
  displayPrice: string;
}

export interface PdfChefPurchaseAccess {
  unlocked: boolean;
  lifetimeOwned: boolean;
  monthlyActive: boolean;
  monthlyExpirationDate: string | null;
  freeJobsRemaining: number;
  freeWindowEndsAt: string | null;
}

export interface PdfChefPurchaseResult {
  status: 'purchased' | 'pending' | 'cancelled';
  access: PdfChefPurchaseAccess;
}

export interface PdfChefPurchasesNativePlugin {
  getProducts(): Promise<{ products: PdfChefPurchaseProduct[] }>;
  getAccessState(): Promise<PdfChefPurchaseAccess>;
  recordFreeJob(options: { operationId: string }): Promise<{
    status: 'allowed' | 'exhausted';
    access: PdfChefPurchaseAccess;
  }>;
  purchase(options: { productId: string }): Promise<PdfChefPurchaseResult>;
  restore(): Promise<{ access: PdfChefPurchaseAccess }>;
  manageSubscriptions(): Promise<void>;
  addListener(
    eventName: 'accessChanged',
    listener: (access: PdfChefPurchaseAccess) => void,
  ): Promise<PluginListenerHandle>;
}

/** The registered proxy is safe to import in every runtime; availability is checked separately. */
export const PdfChefPurchases = registerPlugin<PdfChefPurchasesNativePlugin>('PdfChefPurchases');

/** Enforce only with the real iOS native header, never from a proxy's shape. */
export const isPdfChefPurchasesAvailable = (): boolean =>
  Capacitor.getPlatform() === 'ios' && Capacitor.isPluginAvailable('PdfChefPurchases');
