import { localizeError } from '../../services/i18n/errors.ts';
import { formatDate, t } from '../../services/i18n/core.ts';
import { useI18n } from '../../services/i18n/react';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Eye, Image as ImageIcon, Loader2, Lock, Plus, Save, Trash2, X } from 'lucide-react';
import { PDFPreviewModal } from '../UI/PDFPreviewModal';
import { StatusToast } from '../UI/StatusToast';
import { StatusLine } from '../UI/Primitives';
import { ToolScreen } from '../Tool/ToolScreen';
import { Notice } from '../Tool/parts';
import { useWide } from '../../hooks/useMediaQuery';
import { loadPDFDocument, releasePDFDocument, renderPageAsImage } from '../../services/pdfLazy';
import { deliverBlob } from '../../services/pdfShared';
import { normalizeImageFile } from '../../services/imageBrowser';
import { imageProblemOf } from '../../services/imageIntake';
import { useConfirmDiscard } from '../../hooks/useConfirmDiscard';
import type { ProcessingStatus } from '../../types';
import {
  businessDocumentFileName,
  documentDate,
  BusinessDocumentValidationError,
  lineAmountOf,
  parseDocumentNumber,
  formatMoney,
  renderBusinessDocument,
  totalsOf,
  type BusinessDocument,
  type BusinessDocumentKind,
  type BusinessDocumentLogo,
  type DocumentLineItem,
} from '../../services/documents/businessDocument';

/**
 * Typing out an invoice, a receipt or a quote.
 *
 * One screen for all three: they ask for the same things and differ only in
 * what the dates and the last number are called. Splitting them into three
 * forms would be three places to fix the same wording.
 */

/** Your own details are the part nobody wants to retype every month. */
const REMEMBERED_KEY = 'pdfchef.documents.sender.v1';

interface RememberedSender {
  name: string;
  address: string;
  email: string;
  phone: string;
  currency: string;
  accentColor: string;
  taxLabel: string;
  taxRate: string;
}

const EMPTY_SENDER: RememberedSender = {
  name: '',
  address: '',
  email: '',
  phone: '',
  currency: '$',
  accentColor: '#c0392b',
  taxLabel: 'Tax',
  taxRate: '',
};

const readRemembered = (): RememberedSender => {
  try {
    const raw = window.localStorage.getItem(REMEMBERED_KEY);
    if (!raw) return EMPTY_SENDER;
    const parsed = JSON.parse(raw) as Partial<RememberedSender>;
    // Only strings, and only the keys we know: a stored blob is not a contract.
    const pick = (key: keyof RememberedSender) =>
      typeof parsed[key] === 'string' ? (parsed[key] as string) : EMPTY_SENDER[key];
    return {
      name: pick('name'),
      address: pick('address'),
      email: pick('email'),
      phone: pick('phone'),
      currency: pick('currency'),
      accentColor: pick('accentColor'),
      taxLabel: pick('taxLabel'),
      taxRate: pick('taxRate'),
    };
  } catch {
    return EMPTY_SENDER;
  }
};

const today = () => {
  const now = new Date();
  return documentDate(formatDate(now, { day: 'numeric', month: 'long', year: 'numeric' }), now);
};

/**
 * A line as it is being typed, not as it is meant.
 *
 * Amounts stay the literal string the reader entered. Parsing on every
 * keystroke and writing the number back turned "12." into "12" the instant the
 * decimal point was typed, so "12.50" ended up as 1250 and the invoice was out
 * by a hundred times with nothing on screen to show it.
 */
interface LineItemDraft {
  description: string;
  quantity: string;
  unitPrice: string;
}

const blankItem = (): LineItemDraft => ({ description: '', quantity: '1', unitPrice: '' });

/** A logo prints at most 150 x 54 points; half a megapixel is still sharp there. */
const MAX_LOGO_PIXELS = 500_000;

const numberOf = parseDocumentNumber;

const itemOf = (draft: LineItemDraft): DocumentLineItem => ({
  description: draft.description,
  quantity: numberOf(draft.quantity),
  unitPrice: numberOf(draft.unitPrice),
});

/**
 * A labelled field. A hint under the label is not drawn (D8): it becomes the field's
 * placeholder when the field has none, and otherwise its described-by text, kept
 * outside the label so the field's name stays the label alone. `hintInLabel` draws the
 * hint after the label on its line instead, so it is still there once the field is filled
 * and a long one wraps rather than being cut (h4 F5, F7); it is spoken as the description.
 */
const Field: React.FC<{
  label: string;
  hint?: string;
  hintInLabel?: boolean;
  children: React.ReactElement<React.InputHTMLAttributes<HTMLInputElement>>;
}> = ({ label, hint, hintInLabel = false, children }) => {
  useI18n();
  const hintId = useId();
  const hasPlaceholder = children.props.placeholder !== undefined;
  const described = Boolean(hint && (hasPlaceholder || hintInLabel));
  const field = hint
    ? React.cloneElement(children, described ? { 'aria-describedby': hintId } : { placeholder: hint })
    : children;
  return (
    <div className="tk-bizfield">
      <label className="tk-field">
        <span>
          {label}
          {hint && hintInLabel ? <span aria-hidden="true" className="tk-bizfield-hint"> · {hint}</span> : null}
        </span>
        {field}
      </label>
      {described ? <span id={hintId} className="sr-only">{hint}</span> : null}
    </div>
  );
};

/**
 * Page 1 of the document as it will be saved, redrawn 600 ms after the last change with
 * the same drawing "See it first" uses (desktop only, plan 2.21). One draw at a time;
 * a failed draw keeps the last good picture and reports the failure.
 */
const LiveDocument: React.FC<{
  build: () => Promise<File>;
  alt: string;
  /** The reason the last draw failed, or null once a draw succeeds. */
  onFailedChange: (reason: string | null) => void;
}> = ({ build, alt, onFailedChange }) => {
  const [url, setUrl] = useState<string | null>(null);
  const drawing = useRef<Promise<void>>(Promise.resolve());
  const reportFailed = useRef(onFailedChange);
  reportFailed.current = onFailedChange;

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      drawing.current = drawing.current.then(async () => {
        if (cancelled) return;
        try {
          const file = await build();
          const pdf = await loadPDFDocument(file);
          try {
            const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
            const { objectUrl } = await renderPageAsImage(pdf, 0, { scale, format: 'image/png', quality: 1 });
            if (cancelled) { URL.revokeObjectURL(objectUrl); return; }
            setUrl((previous) => {
              if (previous) URL.revokeObjectURL(previous);
              return objectUrl;
            });
            reportFailed.current(null);
          } finally {
            void releasePDFDocument(file).catch(() => undefined);
          }
        } catch (error) {
          if (!cancelled) reportFailed.current(error instanceof BusinessDocumentValidationError ? localizeError(error) : '');
        }
      });
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [build]);

  useEffect(() => () => {
    setUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
  }, []);

  return (
    <figure className="tk-filepreview tk-livedoc">
      <div className="tk-filepreview-page" aria-busy={url ? undefined : true}>
        {url
          ? <img src={url} alt={alt} draggable={false} />
          : <span className="tk-filepreview-loading" role="status">{t('file-preview.loading')}</span>}
      </div>
    </figure>
  );
};

export const BusinessDocumentBuilder: React.FC<{ kind: BusinessDocumentKind }> = ({ kind }: { kind: BusinessDocumentKind }) => {
  useI18n();
  const wording = {
    title: t(`business.${kind}.title`), reference: t(`business.${kind}.reference`),
    issued: t(`business.${kind}.issued`), settled: t(`business.${kind}.settled`),
    recipient: t(`business.${kind}.recipient`), total: t(`business.${kind}.total`),
  };
  const remembered = useMemo(readRemembered, []);

  const [sender, setSender] = useState<RememberedSender>(remembered);
  const [logo, setLogo] = useState<BusinessDocumentLogo | null>(null);
  const [logoName, setLogoName] = useState('');
  const [recipient, setRecipient] = useState({ name: '', address: '', email: '', phone: '' });
  const [reference, setReference] = useState('');
  const [issuedOn, setIssuedOn] = useState(today);
  const [settledOn, setSettledOn] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<LineItemDraft[]>([blankItem()]);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  const [preview, setPreview] = useState<File | null>(null);
  // Shown beside the control they belong to; a toast at the foot of the screen covered the buttons.
  const [logoError, setLogoError] = useState('');
  const [buildError, setBuildError] = useState('');
  const logoInputRef = useRef<HTMLInputElement>(null);
  const wide = useWide();
  const [liveFailed, setLiveFailed] = useState<string | null>(null);

  // The sender is remembered as it is typed, so only the rest of the form is lost by leaving.
  const work = JSON.stringify([recipient, reference, issuedOn, settledOn, paymentMethod, notes, items, logoName, logo !== null]);
  const [savedWork, setSavedWork] = useState(work);
  const discardSheet = useConfirmDiscard(work !== savedWork);

  // Remember the sender as they type, so the next one starts filled in.
  useEffect(() => {
    try {
      window.localStorage.setItem(REMEMBERED_KEY, JSON.stringify(sender));
    } catch {
      // A browser refusing storage costs the convenience, not the document.
    }
  }, [sender]);

  const document = useMemo<BusinessDocument>(() => ({
    kind,
    reference,
    issuedOn,
    settledOn: settledOn || undefined,
    paymentMethod: paymentMethod || undefined,
    from: {
      name: sender.name,
      address: sender.address || undefined,
      email: sender.email || undefined,
      phone: sender.phone || undefined,
    },
    to: {
      name: recipient.name,
      address: recipient.address || undefined,
      email: recipient.email || undefined,
      phone: recipient.phone || undefined,
    },
    items: items.map(itemOf),
    currency: sender.currency,
    taxLabel: sender.taxLabel || undefined,
    taxRate: sender.taxRate ? numberOf(sender.taxRate) : undefined,
    notes: notes || undefined,
    accentColor: sender.accentColor,
    logo: logo ?? undefined,
  }), [kind, reference, issuedOn, settledOn, paymentMethod, sender, recipient, items, notes, logo]);

  const totals = useMemo(() => totalsOf(document), [document]);

  const setItem = (index: number, patch: Partial<LineItemDraft>) => {
    setItems((current) => current.map((item, at) => (at === index ? { ...item, ...patch } : item)));
  };

  const chooseLogo = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setLogoError('');
    try {
      // Redrawn upright and small: a phone photo used to go in whole, 8 MB and on its side.
      const normalized = await normalizeImageFile(file, { maxPixels: MAX_LOGO_PIXELS });
      setLogo({ bytes: new Uint8Array(await normalized.arrayBuffer()), format: normalized.type === 'image/png' ? 'png' : 'jpg' });
      setLogoName(file.name);
    } catch (error) {
      setLogoError(imageProblemOf(error) === 'too-large'
        ? t("image-intake.this.picture.is.too.large.to.open.c199e6")
        : t("business-document-builder.that.picture.could.not.be.read.try.6ca5a1"));
    }
  };

  const build = useCallback(async () => {
    const bytes = await renderBusinessDocument(document);
    return new File([bytes as BlobPart], businessDocumentFileName(document), {
      type: 'application/pdf',
    });
  }, [document]);

  // A message about the form goes away once the form changes.
  useEffect(() => setBuildError(''), [document]);

  const handlePreview = async () => {
    setBuildError('');
    setStatus({ isProcessing: true, progress: 40, message: t(`business.${kind}.drawing`) });
    try {
      setPreview(await build());
      setStatus({ isProcessing: false, progress: 100, message: '' });
    } catch (error) {
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '' });
      setBuildError(error instanceof BusinessDocumentValidationError ? localizeError(error) : t(`business.${kind}.cannotDraw`));
    }
  };

  const handleSave = async () => {
    setBuildError('');
    setStatus({ isProcessing: true, progress: 40, message: t(`business.${kind}.drawing`) });
    try {
      const file = await build();
      const delivery = await deliverBlob(file, file.name, 'application/pdf');
      if (delivery.status === 'preview') {
        setStatus({
          isProcessing: false,
          progress: 100,
          message: t(`business.${kind}.preview`),
        });
        return;
      }
      setSavedWork(work);
      setStatus({ isProcessing: false, progress: 100, message: t(`business.${kind}.ready`) });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        setStatus({ isProcessing: false, progress: 0, message: t("business-document-builder.save.cancelled.1d024f") });
        return;
      }
      console.error(error);
      setStatus({ isProcessing: false, progress: 0, message: '' });
      setBuildError(error instanceof BusinessDocumentValidationError ? localizeError(error) : t(`business.${kind}.cannotSave`));
    }
  };

  const title = t(`business.${kind}.maker`);
  const sectionHeading = 'tk-bizhead';
  const colourHintId = `business-${kind}-colour-hint`;
  const logoHintId = `business-${kind}-logo-hint`;
  const yourDetailsHintId = `business-${kind}-details-hint`;

  const form = (
    <div className="tk-bizform">
        {/* -------------------------------------------------- your details -- */}
        <section className="tk-bizsec" aria-label={t("business-document-builder.your.details.c0bcd4")} aria-describedby={yourDetailsHintId}>
          <h2 className={sectionHeading}>{t("business-document-builder.your.details.c0bcd4")}</h2>
          <div className="tk-bizfields">
            <Field label={t("business-document-builder.your.name.or.business.5a3dbc")}>
              <input
                className="chef-field"
                value={sender.name}
                onChange={(event) => setSender({ ...sender, name: event.target.value })}
                autoComplete="organization"
              />
            </Field>
            <Field label={t("business-document-builder.address.56ef8f")} hint={t("business-document-builder.one.line.each.as.you.would.write.8ae47d")}>
              <textarea
                className="chef-field tk-bizarea"
                value={sender.address}
                onChange={(event) => setSender({ ...sender, address: event.target.value })}
              />
            </Field>
            <div className="tk-bizpair">
              <Field label={t("business-document-builder.email.969ccb")}>
                <input
                  className="chef-field"
                  type="email"
                  value={sender.email}
                  onChange={(event) => setSender({ ...sender, email: event.target.value })}
                  autoComplete="email"
                />
              </Field>
              <Field label={t("business-document-builder.phone.63dceb")}>
                <input
                  className="chef-field"
                  type="tel"
                  value={sender.phone}
                  onChange={(event) => setSender({ ...sender, phone: event.target.value })}
                  autoComplete="tel"
                />
              </Field>
            </div>
            <div className="tk-bizpair">
              <Field label={t("business-document-builder.money.symbol.e4928f")} hint={t("business-document-builder.a.symbol.like.or.or.a.code.4bfcd9")}>
                <input
                  className="chef-field"
                  value={sender.currency}
                  onChange={(event) => setSender({ ...sender, currency: event.target.value })}
                />
              </Field>
              <div className="tk-bizfield">
                <div className="tk-field">
                  <span>{t("business-document-builder.colour.3a9dfa")}</span>
                  <span className="tk-bizcolour">
                    <input
                      type="color"
                      aria-label={t("business-document-builder.pick.your.colour.8b6765")}
                      aria-describedby={colourHintId}
                      className="tk-swatch"
                      value={/^#[0-9a-f]{6}$/i.test(sender.accentColor) ? sender.accentColor : '#c0392b'}
                      onChange={(event) => setSender({ ...sender, accentColor: event.target.value })}
                    />
                    {/* A colour code reads left to right in every language: in Arabic "#c0392b" showed as "c0392b#" (desktop-r9-06). */}
                    <input
                      className="chef-field"
                      dir="ltr"
                      spellCheck={false}
                      aria-label={t("business-document-builder.colour.code.3a26d6")}
                      aria-describedby={colourHintId}
                      value={sender.accentColor}
                      onChange={(event) => setSender({ ...sender, accentColor: event.target.value })}
                    />
                  </span>
                </div>
                <span id={colourHintId} className="sr-only">{t("business-document-builder.used.for.the.title.and.the.total.0c24ce")}</span>
              </div>
            </div>
            <div className="tk-bizfield">
              <span className="tk-field"><span>{t("business-document-builder.logo.d707dc")}</span></span>
              <span id={logoHintId} className="sr-only">{t("business-document-builder.a.jpg.or.png.it.sits.at.fa7de7")}</span>
              <input
                ref={logoInputRef}
                type="file"
                accept="image/png,image/jpeg"
                aria-hidden="true"
                tabIndex={-1}
                className="sr-only"
                onChange={(event) => {
                  void chooseLogo(event.target.files);
                  event.target.value = '';
                }}
              />
              <div className="tk-bizlogo">
                <button type="button" onClick={() => logoInputRef.current?.click()} aria-describedby={logoHintId} className="tk-btn chef-pressable">
                  <ImageIcon aria-hidden size={16} />
                  <span>{logo ? t("business-document-builder.change.logo.a1ab83") : t("business-document-builder.choose.a.logo.6c5e0f")}</span>
                </button>
                {logo ? (
                  <>
                    <span className="chef-filename tk-bizlogo-name">
                      {logoName}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setLogo(null);
                        setLogoName('');
                      }}
                      className="tk-btn tk-btn-quiet chef-pressable"
                    >
                      <X aria-hidden size={16} />
                      <span>{t("business-document-builder.remove.c3812f")}</span>
                    </button>
                  </>
                ) : null}
              </div>
              {logoError ? (
                <div role="alert">
                  <StatusLine tone="danger" icon={<AlertTriangle size={16} />}>{logoError}</StatusLine>
                </div>
              ) : null}
            </div>
          </div>
          {/* The privacy promise for these fields (research r1, desktop-01): drawn after them, inside
              their group, not as a line under the heading. */}
          <p id={yourDetailsHintId} className="tk-bizsec-note">
            <Lock aria-hidden size={14} />
            <span>{t("business-document-builder.filled.in.for.you.next.time.on.833430")}</span>
          </p>
        </section>

        {/* ------------------------------------------------ their details -- */}
        <section className="tk-bizsec" aria-label={wording.recipient}>
          <h2 className={sectionHeading}>
            {wording.recipient}
          </h2>
          <div className="tk-bizfields">
            <Field label={t("business-document-builder.name.dcd1d5")}>
              <input
                className="chef-field"
                value={recipient.name}
                onChange={(event) => setRecipient({ ...recipient, name: event.target.value })}
              />
            </Field>
            <Field label={t("business-document-builder.address.56ef8f")}>
              <textarea
                className="chef-field tk-bizarea"
                value={recipient.address}
                onChange={(event) => setRecipient({ ...recipient, address: event.target.value })}
              />
            </Field>
            <div className="tk-bizpair">
              <Field label={t("business-document-builder.email.969ccb")}>
                <input
                  className="chef-field"
                  type="email"
                  value={recipient.email}
                  onChange={(event) => setRecipient({ ...recipient, email: event.target.value })}
                />
              </Field>
              <Field label={t("business-document-builder.phone.63dceb")}>
                <input
                  className="chef-field"
                  type="tel"
                  value={recipient.phone}
                  onChange={(event) => setRecipient({ ...recipient, phone: event.target.value })}
                />
              </Field>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------- the numbers --- */}
        <section className="tk-bizsec" aria-label={t("business-document-builder.dates.and.numbering.128e9a")}>
          <h2 className={sectionHeading}>{t("business-document-builder.dates.and.numbering.128e9a")}</h2>
          <div className="tk-bizpair">
            <Field label={wording.reference} hint={t("business-document-builder.anything.you.like.as.long.as.you.fa8131")} hintInLabel>
              <input
                className="chef-field"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
              />
            </Field>
            <Field label={wording.issued}>
              <input
                className="chef-field"
                value={issuedOn}
                onChange={(event) => setIssuedOn(event.target.value)}
              />
            </Field>
            <Field label={wording.settled}>
              <input
                className="chef-field"
                value={settledOn}
                onChange={(event) => setSettledOn(event.target.value)}
              />
            </Field>
            {kind === 'receipt' ? (
              <Field label={t("business-document-builder.paid.by.a891cb")} hint={t("business-document-builder.card.cash.bank.transfer.348c71")}>
                <input
                  className="chef-field"
                  value={paymentMethod}
                  onChange={(event) => setPaymentMethod(event.target.value)}
                />
              </Field>
            ) : null}
          </div>
        </section>

        {/* ---------------------------------------------------- the lines -- */}
        <section className="tk-bizsec" aria-label={t("business-document-builder.what.it.is.for.1ad944")}>
          <h2 className={sectionHeading}>{t("business-document-builder.what.it.is.for.1ad944")}</h2>
          <div className="tk-bizfields">
            {items.map((item, index) => (
              <div key={index} className="tk-bizline">
                <Field label={t("business-document-builder.line.257307", { v0: index + 1 })}>
                  <input
                    className="chef-field"
                    placeholder={t("business-document-builder.what.you.did.or.what.you.sold.8b241f")}
                    value={item.description}
                    onChange={(event) => setItem(index, { description: event.target.value })}
                  />
                </Field>
                <div className="tk-bizline-nums">
                  <Field label={t("business-document-builder.how.many.e2a6ff")}>
                    <input
                      className="chef-field"
                      inputMode="decimal"
                      value={item.quantity}
                      onChange={(event) => setItem(index, { quantity: event.target.value })}
                    />
                  </Field>
                  <Field label={t("business-document-builder.price.each.df302a")}>
                    <input
                      className="chef-field"
                      inputMode="decimal"
                      value={item.unitPrice}
                      onChange={(event) => setItem(index, { unitPrice: event.target.value })}
                    />
                  </Field>
                  <button
                    type="button"
                    aria-label={t("business-document-builder.remove.line.fe6393", { v0: index + 1 })}
                    onClick={() => setItems((current) =>
                      current.length === 1 ? [blankItem()] : current.filter((_, at) => at !== index))}
                    className="tk-iconbtn tk-iconbtn-danger chef-pressable"
                  >
                    <Trash2 aria-hidden size={18} />
                  </button>
                </div>
                <p className="tk-bizline-amount tabular">
                  {formatMoney(lineAmountOf(itemOf(item)), sender.currency)}
                </p>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setItems((current) => [...current, blankItem()])}
              className="tk-btn chef-pressable tk-bizadd"
            >
              <Plus aria-hidden size={16} />
              <span>{t("business-document-builder.add.another.line.f2daca")}</span>
            </button>
          </div>

          <div className="tk-bizpair tk-biztax">
            <Field label={t("business-document-builder.tax.name.ae6611")} hint={t("business-document-builder.vat.gst.sales.tax.or.leave.it.56a53b")}>
              <input
                className="chef-field"
                value={sender.taxLabel}
                onChange={(event) => setSender({ ...sender, taxLabel: event.target.value })}
              />
            </Field>
            <Field label={t("business-document-builder.tax.ce793a")} hint={t("business-document-builder.leave.blank.for.no.tax.044e69")} hintInLabel>
              <input
                className="chef-field"
                inputMode="decimal"
                value={sender.taxRate}
                onChange={(event) => setSender({ ...sender, taxRate: event.target.value })}
              />
            </Field>
          </div>

          <dl className="tk-biztotals">
            <div>
              <dt>{t("business-document-builder.subtotal.8c0f2c")}</dt>
              <dd className="tabular">{formatMoney(totals.subtotal, sender.currency)}</dd>
            </div>
            {totals.tax ? (
              <div>
                <dt>{sender.taxLabel || t("business-document-builder.tax.47e288")}</dt>
                <dd className="tabular">{formatMoney(totals.tax, sender.currency)}</dd>
              </div>
            ) : null}
            <div className="tk-biztotals-sum">
              <dt>{wording.total}</dt>
              <dd className="tabular">{formatMoney(totals.total, sender.currency)}</dd>
            </div>
          </dl>
        </section>

        {/* -------------------------------------------------------- notes -- */}
        <section className="tk-bizsec" aria-label={t("business-document-builder.notes.8a7525")}>
          <Field label={t("business-document-builder.notes.8a7525")} hint={t("business-document-builder.payment.terms.a.thank.you.anything.else.113c30")}>
            <textarea
              className="chef-field tk-bizarea"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
        </section>
    </div>
  );

  // The total, as plain text where a sentence would be.
  const totalLine = (
    <p className="tk-biztotal">
      <span>{wording.total}</span>
      <bdi className="tabular">{formatMoney(totals.total, sender.currency)}</bdi>
    </p>
  );

  const notice = buildError
    ? <Notice tone="error" role="alert">{buildError}</Notice>
    : wide && liveFailed !== null
      ? <Notice tone="caution" role="status">{liveFailed || t(`business.${kind}.cannotDraw`)}</Notice>
      : null;

  const secondary = (
    <button type="button" onClick={() => void handlePreview()} className="tk-btn tk-btn-outline chef-pressable">
      <Eye aria-hidden size={18} />
      <span>{t("business-document-builder.see.it.first.04adbf")}</span>
    </button>
  );
  const action = (
    <button
      type="button"
      onClick={() => void handleSave()}
      disabled={status.isProcessing}
      aria-busy={status.isProcessing || undefined}
      className="tk-primary chef-pressable"
    >
      {status.isProcessing ? <Loader2 aria-hidden className="animate-spin" size={18} /> : <Save aria-hidden size={18} />}
      <span>{t(`business.${kind}.save`)}</span>
    </button>
  );

  return (
    <ToolScreen
      title={title}
      kind="form"
      // Typed and not saved: reload and a closed tab ask, as Back and the links do (s1-01).
      holdsWork={work !== savedWork}
      className="tk-biz"
      bodyLabel={title}
      body={wide ? <LiveDocument build={build} alt={wording.title} onFailedChange={setLiveFailed} /> : form}
      side={wide ? form : undefined}
      sentence={totalLine}
      notice={notice}
      secondary={secondary}
      action={action}
      extra={(
        <>
          {preview ? (
            <PDFPreviewModal
              file={preview}
              pageIndex={0}
              pageLabel={wording.title}
              onClose={() => setPreview(null)}
            />
          ) : null}
          {discardSheet}
        </>
      )}
      toast={<StatusToast status={status} />}
    />
  );
};

export const CreateInvoice: React.FC = () => { useI18n(); return <BusinessDocumentBuilder kind="invoice" />; };
export const CreateReceipt: React.FC = () => { useI18n(); return <BusinessDocumentBuilder kind="receipt" />; };
export const CreateQuote: React.FC = () => { useI18n(); return <BusinessDocumentBuilder kind="quote" />; };
