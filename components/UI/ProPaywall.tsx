import { localizeError } from '../../services/i18n/errors.ts';
import { t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useMemo, useState } from 'react';
import { Check, ExternalLink, RotateCcw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useMonetization } from '../../hooks/useMonetization';
import { Button, Sheet, StatusLine } from './Primitives';

/**
 * The only purchase surface in the web UI. It is mounted globally, but the
 * StoreKit-backed provider keeps it closed everywhere except native iOS.
 */
export const ProPaywall: React.FC = () => {
  useI18n();
  const {
    available,
    loading,
    products,
    error: providerError,
    paywallOpen,
    dismissPaywall,
    purchase,
    restore,
  } = useMonetization();
  const [busyProduct, setBusyProduct] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState<{ tone: 'info' | 'success' | 'caution' | 'danger'; text: string } | null>(null);

  const productByKind = useMemo(
    () => ({
      lifetime: products.find(product => product.kind === 'lifetime'),
      monthly: products.find(product => product.kind === 'monthly'),
    }),
    [products],
  );

  const buy = useCallback(async (productId: string, kind: 'lifetime' | 'monthly') => {
    setBusyProduct(productId);
    setMessage(null);
    try {
      const result = await purchase(productId);
      if (result.status === 'pending') {
        setMessage({ tone: 'info', text: t("pro-paywall.your.purchase.is.pending.apple.approval.access.4e11c8") });
      } else if (result.status === 'cancelled') {
        setMessage({ tone: 'caution', text: t("pro-paywall.purchase.cancelled.no.charge.was.made.c6979a") });
      } else {
        setMessage({ tone: 'success', text: kind === 'monthly' ? t("pro-paywall.pro.monthly.is.active.827afe") : t("pro-paywall.pro.lifetime.is.active.bfaf70") });
      }
    } catch (caught) {
      setMessage({ tone: 'danger', text: caught instanceof Error && caught.message ? localizeError(caught) : t("pro-paywall.purchase.could.not.be.completed.7dc3ee") });
    } finally {
      setBusyProduct(null);
    }
  }, [purchase]);

  const doRestore = useCallback(async () => {
    setRestoring(true);
    setMessage(null);
    try {
      const access = await restore();
      setMessage({
        tone: access.unlocked ? 'success' : 'info',
        text: access.unlocked ? t("pro-paywall.your.pro.access.has.been.restored.ff4ea5") : t("pro-paywall.no.previous.pro.purchase.was.found.for.9e318b"),
      });
    } catch (caught) {
      setMessage({ tone: 'danger', text: caught instanceof Error && caught.message ? localizeError(caught) : t("pro-paywall.restore.could.not.be.completed.ccc989") });
    } finally {
      setRestoring(false);
    }
  }, [restore]);

  if (!available || !paywallOpen) return null;

  return (
    <Sheet
      open={paywallOpen}
      onClose={dismissPaywall}
      title={t("pro-paywall.unlock.pdf.chef.pro.cf6c72")}
      description={t("pro-paywall.processing.stays.unlimited.each.7.day.allowance.cbf20f")}
    >
      <div className="space-y-3">
        <ul className="space-y-2 text-sm text-[var(--text-primary)]">
          <li className="flex items-start gap-2"><Check aria-hidden size={17} className="mt-0.5 shrink-0 text-[var(--status-success-text)]" />{t("pro-paywall.save.share.and.use.every.result.77994c")}</li>
          <li className="flex items-start gap-2"><Check aria-hidden size={17} className="mt-0.5 shrink-0 text-[var(--status-success-text)]" />{t("pro-paywall.keep.using.local.offline.document.processing.71ff1c")}</li>
          <li className="flex items-start gap-2"><Check aria-hidden size={17} className="mt-0.5 shrink-0 text-[var(--status-success-text)]" />{t("pro-paywall.no.document.uploads.or.account.required.00da26")}</li>
        </ul>

        {providerError && <StatusLine tone="danger">{localizeError(providerError)}</StatusLine>}
        {message && <StatusLine tone={message.tone}>{message.text}</StatusLine>}

        {loading && products.length === 0 ? (
          <StatusLine tone="info">{t("pro-paywall.loading.localized.app.store.prices.6e84c6")}</StatusLine>
        ) : products.length === 0 ? (
          <StatusLine tone="caution">{t("pro-paywall.app.store.prices.are.unavailable.right.now.e4f7e5")}</StatusLine>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {([productByKind.lifetime, productByKind.monthly]).map(product => product && (
              <Button
                key={product.productId}
                tone={product.kind === 'lifetime' ? 'primary' : 'secondary'}
                busy={busyProduct === product.productId}
                block
                onClick={() => void buy(product.productId, product.kind)}
              >
                <span className="flex flex-col items-center gap-0.5">
                  <span>{product.kind === 'lifetime' ? t("pro-paywall.pro.lifetime.ca0b3d") : t("pro-paywall.pro.monthly.fc7aed")}</span>
                  <span className="text-xs font-medium opacity-85">
                    {product.displayPrice}{product.kind === 'monthly' ? t("pro-paywall.month.384280") : t("pro-paywall.one.time.181d11")}
                  </span>
                </span>
              </Button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-hairline)] pt-3">
          <Button tone="quiet" busy={restoring} icon={<RotateCcw aria-hidden size={15} />} onClick={() => void doRestore()}>{t("pro-paywall.restore.purchases.c63999")}</Button>
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <Link className="inline-flex items-center gap-1 underline underline-offset-2" to="/terms">{t("pro-paywall.terms.aaaec5")}<ExternalLink aria-hidden size={12} /></Link>
            <Link className="inline-flex items-center gap-1 underline underline-offset-2" to="/privacy">{t("pro-paywall.privacy.1a2fd3")}<ExternalLink aria-hidden size={12} /></Link>
          </div>
        </div>
        <p className="type-footnote text-[var(--text-tertiary)]">{t("pro-paywall.pro.monthly.is.a.one.month.subscription.9a52d5")}</p>
      </div>
    </Sheet>
  );
};
