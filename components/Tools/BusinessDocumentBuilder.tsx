import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, Image as ImageIcon, Plus, Save, Trash2, X } from 'lucide-react';
import { PDFPreviewModal } from '../UI/PDFPreviewModal';
import { StatusToast } from '../UI/StatusToast';
import { Button } from '../UI/Primitives';
import { ToolHeader, ToolPanel, ToolShell } from '../UI/ToolLayout';
import { deliverBlob } from '../../services/pdfShared';
import type { ProcessingStatus } from '../../types';
import {
  businessDocumentFileName,
  BusinessDocumentValidationError,
  lineAmountOf,
  parseDocumentNumber,
  documentWording,
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

const today = () =>
  new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

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

const numberOf = parseDocumentNumber;

const itemOf = (draft: LineItemDraft): DocumentLineItem => ({
  description: draft.description,
  quantity: numberOf(draft.quantity),
  unitPrice: numberOf(draft.unitPrice),
});

const Field: React.FC<{
  label: string;
  hint?: string;
  children: React.ReactNode;
}> = ({ label, hint, children }) => (
  <label className="block">
    <span className="block text-sm font-semibold text-[var(--text-primary)]">{label}</span>
    {hint ? <span className="type-footnote mb-1.5 block text-[var(--text-secondary)]">{hint}</span> : null}
    <span className={hint ? 'block' : 'mt-1.5 block'}>{children}</span>
  </label>
);

export const BusinessDocumentBuilder: React.FC<{ kind: BusinessDocumentKind }> = ({ kind }) => {
  const wording = documentWording(kind);
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
  const logoInputRef = useRef<HTMLInputElement>(null);

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
    const format = /\.png$/i.test(file.name) || file.type === 'image/png' ? 'png' : 'jpg';
    try {
      setLogo({ bytes: new Uint8Array(await file.arrayBuffer()), format });
      setLogoName(file.name);
    } catch {
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: 'That picture could not be read. Try a JPG or PNG instead.',
      });
    }
  };

  const build = useCallback(async () => {
    const bytes = await renderBusinessDocument(document);
    return new File([bytes as BlobPart], businessDocumentFileName(document), {
      type: 'application/pdf',
    });
  }, [document]);

  const handlePreview = async () => {
    setStatus({ isProcessing: true, progress: 40, message: `Drawing your ${wording.title.toLowerCase()}…` });
    try {
      setPreview(await build());
      setStatus({ isProcessing: false, progress: 100, message: '' });
    } catch (error) {
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof BusinessDocumentValidationError ? error.message : `This ${wording.title.toLowerCase()} could not be drawn. Check the amounts, then try again.`,
      });
    }
  };

  const handleSave = async () => {
    setStatus({ isProcessing: true, progress: 40, message: `Drawing your ${wording.title.toLowerCase()}…` });
    try {
      const file = await build();
      await deliverBlob(file, file.name, 'application/pdf');
      setStatus({ isProcessing: false, progress: 100, message: `${wording.title} ready.` });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        setStatus({ isProcessing: false, progress: 0, message: 'Save cancelled.' });
        return;
      }
      console.error(error);
      setStatus({
        isProcessing: false,
        progress: 0,
        message: '',
        error: error instanceof BusinessDocumentValidationError ? error.message : `This ${wording.title.toLowerCase()} could not be saved. Try Save again or choose another destination.`,
      });
    }
  };

  return (
    <ToolShell>
      <ToolHeader title={`${wording.title} maker`} />

      <div className="space-y-3">
        {/* -------------------------------------------------- your details -- */}
        <ToolPanel as="section" aria-label="Your details">
          <h2 className="mb-2.5 text-sm font-bold uppercase tracking-[0.14em] text-[var(--text-secondary)]">
            Your details
          </h2>
          <p className="type-footnote mb-3 text-[var(--text-secondary)]">
            Filled in for you next time, on this device only.
          </p>
          <div className="space-y-2.5">
            <Field label="Your name or business">
              <input
                className="chef-field"
                value={sender.name}
                onChange={(event) => setSender({ ...sender, name: event.target.value })}
                autoComplete="organization"
              />
            </Field>
            <Field label="Address" hint="One line each, as you would write it on an envelope">
              <textarea
                className="chef-field min-h-[76px] resize-y"
                value={sender.address}
                onChange={(event) => setSender({ ...sender, address: event.target.value })}
              />
            </Field>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <Field label="Email">
                <input
                  className="chef-field"
                  type="email"
                  value={sender.email}
                  onChange={(event) => setSender({ ...sender, email: event.target.value })}
                  autoComplete="email"
                />
              </Field>
              <Field label="Phone">
                <input
                  className="chef-field"
                  type="tel"
                  value={sender.phone}
                  onChange={(event) => setSender({ ...sender, phone: event.target.value })}
                  autoComplete="tel"
                />
              </Field>
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <Field label="Money symbol" hint="A symbol like $ or £, or a code like USD">
                <input
                  className="chef-field"
                  value={sender.currency}
                  onChange={(event) => setSender({ ...sender, currency: event.target.value })}
                />
              </Field>
              <Field label="Colour" hint="Used for the title and the total">
                <span className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label="Pick your colour"
                    className="chef-target h-11 w-14 shrink-0 cursor-pointer rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface-canvas)] p-1"
                    value={/^#[0-9a-f]{6}$/i.test(sender.accentColor) ? sender.accentColor : '#c0392b'}
                    onChange={(event) => setSender({ ...sender, accentColor: event.target.value })}
                  />
                  <input
                    className="chef-field"
                    aria-label="Colour code"
                    value={sender.accentColor}
                    onChange={(event) => setSender({ ...sender, accentColor: event.target.value })}
                  />
                </span>
              </Field>
            </div>
            <div>
              <span className="block text-sm font-semibold text-[var(--text-primary)]">Logo</span>
              <span className="type-footnote mb-1.5 block text-[var(--text-secondary)]">
                A JPG or PNG. It sits at the top, in place of your name.
              </span>
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
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  icon={<ImageIcon aria-hidden size={16} />}
                  onClick={() => logoInputRef.current?.click()}
                >
                  {logo ? 'Change logo' : 'Choose a logo'}
                </Button>
                {logo ? (
                  <>
                    <span className="chef-filename type-footnote min-w-0 flex-1 text-[var(--text-secondary)]">
                      {logoName}
                    </span>
                    <Button
                      tone="quiet"
                      icon={<X aria-hidden size={16} />}
                      onClick={() => {
                        setLogo(null);
                        setLogoName('');
                      }}
                    >
                      Remove
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </ToolPanel>

        {/* ------------------------------------------------ their details -- */}
        <ToolPanel as="section" aria-label={wording.recipient}>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-[0.14em] text-[var(--text-secondary)]">
            {wording.recipient}
          </h2>
          <div className="space-y-2.5">
            <Field label="Name">
              <input
                className="chef-field"
                value={recipient.name}
                onChange={(event) => setRecipient({ ...recipient, name: event.target.value })}
              />
            </Field>
            <Field label="Address">
              <textarea
                className="chef-field min-h-[76px] resize-y"
                value={recipient.address}
                onChange={(event) => setRecipient({ ...recipient, address: event.target.value })}
              />
            </Field>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <Field label="Email">
                <input
                  className="chef-field"
                  type="email"
                  value={recipient.email}
                  onChange={(event) => setRecipient({ ...recipient, email: event.target.value })}
                />
              </Field>
              <Field label="Phone">
                <input
                  className="chef-field"
                  type="tel"
                  value={recipient.phone}
                  onChange={(event) => setRecipient({ ...recipient, phone: event.target.value })}
                />
              </Field>
            </div>
          </div>
        </ToolPanel>

        {/* ------------------------------------------------- the numbers --- */}
        <ToolPanel as="section" aria-label="Dates and numbering">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-[0.14em] text-[var(--text-secondary)]">
            Dates and numbering
          </h2>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <Field label={wording.reference} hint="Anything you like, as long as you do not reuse it">
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
              <Field label="Paid by" hint="Card, cash, bank transfer">
                <input
                  className="chef-field"
                  value={paymentMethod}
                  onChange={(event) => setPaymentMethod(event.target.value)}
                />
              </Field>
            ) : null}
          </div>
        </ToolPanel>

        {/* ---------------------------------------------------- the lines -- */}
        <ToolPanel as="section" aria-label="What it is for">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-[0.14em] text-[var(--text-secondary)]">
            What it is for
          </h2>
          <div className="space-y-3">
            {items.map((item, index) => (
              <div
                key={index}
                className="rounded-[var(--radius-field)] border border-[var(--border-hairline)] bg-[var(--surface-sunken)] p-2.5"
              >
                <Field label={`Line ${index + 1}`}>
                  <input
                    className="chef-field"
                    placeholder="What you did, or what you sold"
                    value={item.description}
                    onChange={(event) => setItem(index, { description: event.target.value })}
                  />
                </Field>
                <div className="mt-2.5 grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                  <Field label="How many">
                    <input
                      className="chef-field"
                      inputMode="decimal"
                      value={item.quantity}
                      onChange={(event) => setItem(index, { quantity: event.target.value })}
                    />
                  </Field>
                  <Field label="Price each">
                    <input
                      className="chef-field"
                      inputMode="decimal"
                      value={item.unitPrice}
                      onChange={(event) => setItem(index, { unitPrice: event.target.value })}
                    />
                  </Field>
                  <Button
                    tone="quiet"
                    aria-label={`Remove line ${index + 1}`}
                    icon={<Trash2 aria-hidden size={18} />}
                    onClick={() => setItems((current) =>
                      current.length === 1 ? [blankItem()] : current.filter((_, at) => at !== index))}
                  />
                </div>
                <p className="type-footnote mt-2 text-right text-[var(--text-secondary)]">
                  {formatMoney(lineAmountOf(itemOf(item)), sender.currency)}
                </p>
              </div>
            ))}
            <Button
              icon={<Plus aria-hidden size={16} />}
              onClick={() => setItems((current) => [...current, blankItem()])}
              block
            >
              Add another line
            </Button>
          </div>

          <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
            <Field label="Tax name" hint="VAT, GST, Sales tax — or leave it blank">
              <input
                className="chef-field"
                value={sender.taxLabel}
                onChange={(event) => setSender({ ...sender, taxLabel: event.target.value })}
              />
            </Field>
            <Field label="Tax %" hint="Leave blank for no tax">
              <input
                className="chef-field"
                inputMode="decimal"
                value={sender.taxRate}
                onChange={(event) => setSender({ ...sender, taxRate: event.target.value })}
              />
            </Field>
          </div>

          <dl className="mt-3 space-y-1 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] p-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-[var(--text-secondary)]">Subtotal</dt>
              <dd className="tabular font-medium">{formatMoney(totals.subtotal, sender.currency)}</dd>
            </div>
            {totals.tax ? (
              <div className="flex justify-between">
                <dt className="text-[var(--text-secondary)]">{sender.taxLabel || 'Tax'}</dt>
                <dd className="tabular font-medium">{formatMoney(totals.tax, sender.currency)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between border-t border-[var(--border-hairline)] pt-1">
              <dt className="font-bold">{wording.total}</dt>
              <dd className="tabular text-base font-bold">{formatMoney(totals.total, sender.currency)}</dd>
            </div>
          </dl>
        </ToolPanel>

        {/* -------------------------------------------------------- notes -- */}
        <ToolPanel as="section" aria-label="Notes">
          <Field label="Notes" hint="Payment terms, a thank you, anything else worth saying">
            <textarea
              className="chef-field min-h-[88px] resize-y"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
        </ToolPanel>

        <div className="grid gap-2 sm:grid-cols-2">
          <Button icon={<Eye aria-hidden size={18} />} onClick={() => void handlePreview()} block>
            See it first
          </Button>
          <Button
            tone="primary"
            icon={<Save aria-hidden size={18} />}
            busy={status.isProcessing}
            onClick={() => void handleSave()}
            block
          >
            Save {wording.title.toLowerCase()}
          </Button>
        </div>
      </div>

      {preview ? (
        <PDFPreviewModal
          file={preview}
          pageIndex={0}
          pageLabel={wording.title}
          onClose={() => setPreview(null)}
        />
      ) : null}

      <StatusToast status={status} />
    </ToolShell>
  );
};

export const CreateInvoice: React.FC = () => <BusinessDocumentBuilder kind="invoice" />;
export const CreateReceipt: React.FC = () => <BusinessDocumentBuilder kind="receipt" />;
export const CreateQuote: React.FC = () => <BusinessDocumentBuilder kind="quote" />;
