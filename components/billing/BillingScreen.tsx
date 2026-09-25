"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiFetch, qs } from "@/lib/client";
import { describeExpiry, expiryTone, formatExpiry, money } from "@/lib/format";
import {
  describeQuantity,
  describeStock,
  formatUnitCount,
  stripLabel,
  unitWord,
} from "@/lib/pack";
import { Badge, cx } from "@/components/ui";
import { CustomerField } from "@/components/billing/CustomerField";
import { BatchPicker, type PickedItem } from "@/components/billing/BatchPicker";
import { ConfirmSale } from "@/components/billing/ConfirmSale";
import { SaleComplete, type CompletedSale } from "@/components/billing/SaleComplete";
import {
  IRD_BUYER_DETAIL_THRESHOLD,
  PAYMENT_MODES,
  PAYMENT_MODE_LABELS,
  type PaymentMode,
} from "@/lib/constants";
import {
  PAYMENT_STATUS_LABELS,
  givesChange,
  settleSale,
  type PaymentStatus,
} from "@/lib/sale-payment";
import type { SalePlan } from "@/lib/sales";

/**
 * The POS screen.
 *
 * Client component by necessity: search-as-you-type, a live cart, and totals
 * that update on every keystroke. Everything it renders comes from three
 * endpoints - /api/medicines for the search, /api/batches for the lots behind
 * one medicine, and /api/sales/quote for the authoritative FEFO plan.
 *
 * Totals are never computed here. The server owns pricing and VAT, so the
 * number the cashier reads is always the number that will be charged.
 *
 * The counter's path through it is: customer (optional) -> search or scan ->
 * batch -> quantity -> cart -> discount -> payment -> confirm -> invoice.
 * Stock is checked at two points and neither is a button: once as an item is
 * added, and again inside the transaction that posts the sale.
 */

interface MedicineHit {
  id: string;
  name: string;
  genericName: string;
  manufacturer: string;
  unit: string;
  packSize: string;
  barcode: string;
  unitsPerStrip: number;
  requiresPrescription: boolean;
  isActive?: boolean;
  stockQuantity: number;
  nearestExpiry: string | null;
}

/**
 * One row of the cart.
 *
 * Keyed by medicine *and* chosen lot, because "10 Paracetamol from B1" and
 * "5 Paracetamol from B2" are two different things to dispense and the counter
 * must be able to see and change them separately.
 */
interface CartLine {
  key: string;
  medicineId: string;
  /** The lot the counter pinned, or null to let FEFO choose. */
  batchId: string | null;
  name: string;
  unit: string;
  packSize: string;
  unitsPerStrip: number;
  requiresPrescription: boolean;
  quantity: number;
  /** The ceiling this line was added under: one lot's count, or all of them. */
  stockQuantity: number;
}

/**
 * One-tap discounts, in the sizes a pharmacy counter actually gives.
 * "None" is first so clearing one is as quick as setting it.
 */
const DISCOUNT_STEPS = [0, 5, 10, 15, 20] as const;

/** Notes a cashier can hand over without counting: the common ones first. */
const CASH_STEPS = [100, 500, 1000, 5000] as const;

const lineKey = (medicineId: string, batchId: string | null) =>
  `${medicineId}:${batchId ?? "auto"}`;

export function BillingScreen({
  cashierName,
  outletName,
  canDiscount = true,
  canSellOnCredit = true,
  canAddCustomer = false,
  canReceivePayment = false,
}: {
  cashierName: string;
  outletName: string;
  canDiscount?: boolean;
  canSellOnCredit?: boolean;
  canAddCustomer?: boolean;
  canReceivePayment?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [scanMode, setScanMode] = useState(false);
  const [hits, setHits] = useState<MedicineHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [picking, setPicking] = useState<MedicineHit | null>(null);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [qtyDraft, setQtyDraft] = useState<Record<string, string>>({});
  const [discount, setDiscount] = useState("0");
  const [discountPercent, setDiscountPercent] = useState("0");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("cash");
  const [received, setReceived] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerPan, setCustomerPan] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [note, setNote] = useState("");

  const [plan, setPlan] = useState<SalePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<CompletedSale | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const deferredQuery = useDeferredValue(query);

  // --- Search -------------------------------------------------------------
  useEffect(() => {
    const term = deferredQuery.trim();
    if (term.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    setSearching(true);

    // Debounced so a fast typist fires one request, not eight. A scanner types
    // faster still and ends with Enter, which is handled on the keystroke.
    const timer = setTimeout(async () => {
      const result = await apiFetch<MedicineHit[]>(
        "/api/medicines" + qs({ q: term, withStock: "1", pageSize: 8 }),
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setHits(
        result.ok ? result.data.filter((hit) => hit.isActive !== false) : [],
      );
      setHighlight(0);
      setSearching(false);
    }, 180);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [deferredQuery]);

  // --- Live quote ---------------------------------------------------------
  const quantityFor = useCallback(
    (line: CartLine) => {
      const raw = qtyDraft[line.key];
      if (raw === undefined) return line.quantity;
      const parsed = Math.floor(Number(raw));
      if (!Number.isFinite(parsed) || parsed < 1) return line.quantity;
      return Math.min(line.stockQuantity, parsed);
    },
    [qtyDraft],
  );

  const cartKey = useMemo(
    () => cart.map((line) => `${line.key}:${quantityFor(line)}`).join("|"),
    [cart, quantityFor],
  );
  const discountValue = canDiscount ? Number(discount) || 0 : 0;
  // A percentage is resolved on the server, which is the only side that knows
  // what the lines came to once FEFO has split them across batches.
  const percentValue = canDiscount ? Number(discountPercent) || 0 : 0;

  useEffect(() => {
    if (cart.length === 0) {
      setPlan(null);
      setPlanError(null);
      setQuoting(false);
      return;
    }

    const controller = new AbortController();
    setQuoting(true);

    const timer = setTimeout(async () => {
      const result = await apiFetch<SalePlan>("/api/sales/quote", {
        method: "POST",
        signal: controller.signal,
        json: {
          items: cart.map((line) => ({
            medicineId: line.medicineId,
            batchId: line.batchId,
            quantity: quantityFor(line),
          })),
          discount: discountValue,
          discountPercent: percentValue,
        },
      });
      if (controller.signal.aborted) return;

      if (result.ok) {
        setPlan(result.data);
        setPlanError(null);
      } else {
        setPlan(null);
        setPlanError(result.message);
      }
      setQuoting(false);
    }, 150);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [cartKey, discountValue, percentValue, cart, quantityFor]);

  // --- Cart operations ----------------------------------------------------
  /**
   * The automatic stock check, step 6.
   *
   * It is not a button, because a cashier should never have to ask. Adding an
   * item is refused outright when the shelf cannot cover it, the quantity box
   * is capped at what is there, and the sale is re-planned against live stock
   * on every change. The last word still belongs to the server, inside the
   * transaction - between this check and that one, another till may have sold
   * the same lot.
   */
  const addToCart = useCallback(
    (medicine: MedicineHit, pick: PickedItem) => {
      if (medicine.stockQuantity < 1 || medicine.isActive === false) return;

      const add = Math.max(1, Math.floor(pick.quantity) || 1);
      const key = lineKey(medicine.id, pick.batchId);

      setCart((current) => {
        const existing = current.find((line) => line.key === key);
        if (existing) {
          // The picker just re-read the shelf, so its ceiling is fresher than
          // the one this line was added under.
          const ceiling = Math.max(1, pick.available || existing.stockQuantity);
          return current.map((line) =>
            line.key === key
              ? {
                  ...line,
                  stockQuantity: ceiling,
                  quantity: Math.min(ceiling, line.quantity + add),
                }
              : line,
          );
        }
        return [
          ...current,
          {
            key,
            medicineId: medicine.id,
            batchId: pick.batchId,
            name: medicine.name,
            unit: medicine.unit,
            packSize: medicine.packSize,
            unitsPerStrip: medicine.unitsPerStrip || 1,
            requiresPrescription: medicine.requiresPrescription,
            // A pinned line is capped by what the picker allowed; an automatic
            // one by everything sellable. Either way the quote is the truth.
            quantity: add,
            // The picker reports what its choice can supply. Falling back to
            // the medicine's shelf-wide total would let a line pinned to a lot
            // of 6 be nudged up to the 40 sitting in other batches.
            stockQuantity: Math.max(add, pick.available || medicine.stockQuantity),
          },
        ];
      });

      setPicking(null);
      setQuery("");
      setHits([]);
      setSubmitError(null);
      searchRef.current?.focus();
    },
    [],
  );

  const setQuantity = useCallback((key: string, quantity: number) => {
    setQtyDraft((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    setCart((current) =>
      current.map((line) => {
        if (line.key !== key) return line;
        const next = Math.max(1, Math.floor(quantity) || 1);
        return { ...line, quantity: Math.min(line.stockQuantity, next) };
      }),
    );
  }, []);

  const commitQuantity = useCallback(
    (key: string, raw: string, stockQuantity: number) => {
      const parsed = Math.floor(Number(raw));
      const next = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
      setQtyDraft((current) => {
        if (!(key in current)) return current;
        const copy = { ...current };
        delete copy[key];
        return copy;
      });
      setCart((current) =>
        current.map((line) =>
          line.key === key
            ? { ...line, quantity: Math.min(stockQuantity, Math.max(1, next)) }
            : line,
        ),
      );
    },
    [],
  );

  const removeLine = useCallback((key: string) => {
    setQtyDraft((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    setCart((current) => current.filter((line) => line.key !== key));
  }, []);

  const clearCart = useCallback(() => {
    setCart([]);
    setQtyDraft({});
    setDiscount("0");
    setDiscountPercent("0");
    setPaymentMode("cash");
    setReceived("");
    setCustomerName("");
    setCustomerId(null);
    setCustomerPan("");
    setCustomerAddress("");
    setCustomerPhone("");
    setNote("");
    setPlan(null);
    setPlanError(null);
    setSubmitError(null);
    setPicking(null);
    setQuery("");
    setHits([]);
    searchRef.current?.focus();
  }, []);

  // --- Payment ------------------------------------------------------------
  const total = plan?.totalAmount ?? 0;
  const isCash = paymentMode === "cash";
  const onCredit = paymentMode === "credit";

  /**
   * What the counter has taken.
   *
   * An empty box is not zero. On every method except credit it means "the
   * usual thing happened" - the customer paid what was asked - because that is
   * what a cashier who tabs past the field intends. Only credit reads blank as
   * nothing received, which is exactly what credit is. Getting this backwards
   * would quietly file every card sale as an unpaid debt.
   */
  const receivedValue =
    received.trim() === ""
      ? onCredit
        ? 0
        : total
      : Math.max(0, Number(received) || 0);

  // The same function the server settles the bill with, so the status the
  // cashier reads before confirming is the status that gets stored.
  const settlement = settleSale({ totalAmount: total, amountReceived: receivedValue });

  // Change is counted out of a drawer, so it belongs to cash. On a card or a
  // transfer, money over the total is an error to correct at the source.
  const changeDue = givesChange(paymentMode) ? settlement.change : 0;
  const overTendered = settlement.change > 0 && !givesChange(paymentMode);

  // An under-payment is a credit sale whatever button is lit, so it needs the
  // same permission. Blocking it here keeps the cashier from reaching the
  // confirmation only to be refused by the server.
  const paymentBlocked = settlement.remaining > 0 && !canSellOnCredit;

  const buyerNameMissing =
    Boolean(plan) && total >= IRD_BUYER_DETAIL_THRESHOLD && !customerName.trim();

  const readyToConfirm =
    Boolean(plan) &&
    cart.length > 0 &&
    !quoting &&
    !submitting &&
    !paymentBlocked &&
    !planError;

  // --- Submit -------------------------------------------------------------
  const completeSale = useCallback(async () => {
    if (!plan || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);

    const result = await apiFetch<{ id: string; billNo: string; totalAmount: number }>(
      "/api/sales",
      {
        method: "POST",
        json: {
          items: cart.map((line) => ({
            medicineId: line.medicineId,
            batchId: line.batchId,
            quantity: quantityFor(line),
          })),
          customerId,
          customerName: customerName.trim(),
          customerPan: customerPan.trim(),
          customerAddress: customerAddress.trim(),
          customerPhone: customerPhone.trim(),
          discount: discountValue,
          discountPercent: percentValue,
          paymentMode,
          amountReceived: receivedValue,
          note: note.trim(),
        },
      },
    );

    submittingRef.current = false;
    setSubmitting(false);

    if (!result.ok) {
      // The server refused - almost always stock sold from under the cart
      // between the quote and the post. The cart is left alone so the cashier
      // can fix the offending line rather than start again.
      setSubmitError(result.message);
      setConfirming(false);
      return;
    }

    const units = cart.reduce((sum, line) => sum + quantityFor(line), 0);
    setConfirming(false);
    setCompleted({
      id: result.data.id,
      billNo: result.data.billNo,
      customerId,
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      itemCount: units,
      paymentMode,
      totalDue: settlement.totalDue,
      paid: settlement.paid,
      remaining: settlement.remaining,
      changeDue,
      status: settlement.status,
    });
  }, [
    cart,
    changeDue,
    customerAddress,
    customerId,
    customerName,
    customerPan,
    customerPhone,
    discountValue,
    note,
    paymentMode,
    percentValue,
    plan,
    quantityFor,
    receivedValue,
    settlement.paid,
    settlement.remaining,
    settlement.status,
    settlement.totalDue,
  ]);

  // --- Keyboard shortcuts -------------------------------------------------
  useEffect(() => {
    if (completed) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "F4") {
        event.preventDefault();
        setPicking(null);
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      // F9 opens the confirmation from anywhere on the screen. It no longer
      // posts the sale outright: one keystroke should not be able to spend
      // stock and burn a bill number with nothing in between.
      if (event.key === "F9" && readyToConfirm) {
        event.preventDefault();
        setConfirming(true);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [completed, readyToConfirm]);

  /** Express add: the FEFO lot, one unit, no panel. */
  const quickAdd = useCallback(
    (hit: MedicineHit, quantity = 1) => {
      addToCart(hit, {
        batchId: null,
        quantity,
        available: hit.stockQuantity,
      });
    },
    [addToCart],
  );

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setHits([]);
      setQuery("");
      setPicking(null);
      return;
    }
    if (hits.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((index) => (index + 1) % hits.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((index) => (index - 1 + hits.length) % hits.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const hit = hits[highlight];
      if (!hit || hit.stockQuantity <= 0) return;
      // A scanner ends its burst with Enter and the code matched exactly one
      // medicine, so scanning adds straight to the cart - which is the entire
      // point of scanning. Typed search does the same on the FEFO lot.
      quickAdd(hit, 1);
    }
  }

  const planByKey = useMemo(() => {
    const map = new Map<string, SalePlan["lines"][number]>();
    for (const line of plan?.lines ?? []) {
      map.set(lineKey(line.medicineId, line.requestedBatchId), line);
    }
    return map;
  }, [plan]);

  const unitCount = cart.reduce((sum, line) => sum + quantityFor(line), 0);

  // Anything already typed, or pulled in with a saved customer, keeps the
  // buyer panel open so it never hides a value the counter can see is wrong.
  const buyerDetailsFilled = Boolean(
    customerPan.trim() || customerPhone.trim() || customerAddress.trim(),
  );
  const buyerDetailsNeeded =
    buyerDetailsFilled ||
    Boolean(plan && plan.totalAmount >= IRD_BUYER_DETAIL_THRESHOLD);

  // The sale is done. Nothing navigates on its own - the counter chooses.
  if (completed) {
    return (
      <SaleComplete
        sale={completed}
        canReceivePayment={canReceivePayment}
        onNewSale={() => {
          setCompleted(null);
          clearCart();
        }}
      />
    );
  }

  return (
    <>
      <section className="dash-hero relative mb-4 overflow-hidden rounded-2xl px-5 py-4 text-white sm:px-6">
        <div className="login-blister absolute inset-0 opacity-60" aria-hidden="true" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-[0.14em] text-brand-300 uppercase">
              Counter
              <span className="mx-1.5 text-white/30">·</span>
              {outletName}
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">
              New sale
            </h1>
            <p className="mt-1 text-xs text-slate-300">
              Scan or search, pick a batch, add to cart. Batches are earliest
              expiry first and expired stock is never offered.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <div className="hidden items-center gap-2 text-[11px] text-slate-300 sm:flex">
              <Kbd hint="F4">Search</Kbd>
              <Kbd hint="F9">Complete</Kbd>
            </div>
            <div className="text-right">
              <p className="text-[11px] font-semibold tracking-[0.14em] text-brand-300 uppercase">
                This bill
              </p>
              <p className="tnum mt-0.5 text-3xl font-semibold tracking-tight">
                {money(total)}
              </p>
              <p className="text-[11px] text-slate-300">
                {cart.length === 0
                  ? "Empty cart"
                  : `${cart.length} line${cart.length === 1 ? "" : "s"} · ${unitCount} item${unitCount === 1 ? "" : "s"}`}
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        {/* ---------------- Left: search + cart ---------------- */}
        {/*
          Flat white cards with the heading set inside the padding, rather than
          a tinted header band above a body. On a counter screen the tint was
          doing no work - there is only ever one card per job - and losing it
          lets the search box start higher up the card.
        */}
        <div className="space-y-4">
          <div className="card p-4 sm:p-5">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor="medicine-search" className="label">
                {scanMode ? "Scan barcode" : "Search medicine"}
                <span className="ml-2 font-normal text-slate-400">
                  {scanMode
                    ? "hold the scanner to the pack"
                    : "name, generic, brand or barcode"}
                </span>
              </label>

              {/*
                A scanner is a keyboard that types very fast and presses Enter,
                so the box works the same either way. The toggle changes what
                the screen expects rather than how it listens: in scan mode the
                results list stays out of the way and the field re-arms itself.
              */}
              <button
                type="button"
                onClick={() => {
                  setScanMode((on) => !on);
                  setQuery("");
                  setHits([]);
                  setPicking(null);
                  searchRef.current?.focus();
                }}
                aria-pressed={scanMode}
                className={cx(
                  "mb-1 flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-semibold ring-1 transition-colors",
                  scanMode
                    ? "bg-brand-600 text-white ring-brand-600"
                    : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50",
                )}
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    d="M4 7V5a1 1 0 011-1h2m10 0h2a1 1 0 011 1v2M4 17v2a1 1 0 001 1h2m10 0h2a1 1 0 001-1v-2M7 8v8m3-8v8m4-8v8m3-8v8"
                  />
                </svg>
                Scan
              </button>
            </div>

            <div className="relative">
              <svg
                className="pointer-events-none absolute top-1/2 left-3.5 h-5 w-5 -translate-y-1/2 text-slate-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  d="M21 21l-4.3-4.3M17 11a6 6 0 11-12 0 6 6 0 0112 0z"
                />
              </svg>

              <input
                id="medicine-search"
                ref={searchRef}
                type="search"
                autoFocus
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder={
                  scanMode ? "Waiting for a scan…" : "Search a name, generic, brand or barcode"
                }
                enterKeyHint="search"
                autoCapitalize="none"
                autoCorrect="off"
                className="pos-search"
                role="combobox"
                aria-expanded={hits.length > 0}
                aria-controls="medicine-results"
              />

              <kbd className="absolute top-1/2 right-3 -translate-y-1/2 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 ring-1 ring-slate-200 ring-inset">
                F4
              </kbd>
            </div>

            {picking ? (
              <BatchPicker
                key={picking.id}
                medicineId={picking.id}
                medicineName={picking.name}
                unit={picking.unit}
                unitsPerStrip={picking.unitsPerStrip || 1}
                totalStock={picking.stockQuantity}
                onAdd={(pick) => addToCart(picking, pick)}
                onCancel={() => {
                  setPicking(null);
                  searchRef.current?.focus();
                }}
              />
            ) : query.trim().length >= 2 ? (
              <ul
                id="medicine-results"
                role="listbox"
                className="@container mt-3 max-h-[26rem] space-y-1.5 overflow-y-auto overscroll-contain pr-0.5 @lg:max-h-80"
              >
                {searching && hits.length === 0 ? (
                  <li className="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-5 text-sm text-slate-500">
                    Searching…
                  </li>
                ) : null}

                {!searching && hits.length === 0 ? (
                  <li className="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-5 text-sm text-slate-500">
                    No medicine matches “{query.trim()}”.
                    {scanMode ? (
                      <span className="mt-1 block text-xs text-slate-400">
                        If this pack has never been scanned here, add its
                        barcode to the medicine first.
                      </span>
                    ) : null}
                  </li>
                ) : null}

                {hits.map((hit, index) => {
                  const outOfStock = hit.stockQuantity <= 0;
                  const low = !outOfStock && hit.stockQuantity <= 10;
                  const perStrip = hit.unitsPerStrip || 1;
                  const pack = stripLabel(perStrip, hit.unit);
                  return (
                    <li key={hit.id} role="option" aria-selected={index === highlight}>
                      {/*
                        A result is a card rather than a table row: the name
                        block, the stock verdict and the quick-add each own a
                        corner, so the eye lands in the same three places on
                        every row of the list.

                        Sized by the list's own width, not the screen's: this
                        column is phone-narrow on a phone and on a laptop with
                        the payment panel beside it. There, the name takes the
                        whole first line and the stock and quick-add share the
                        second - on one line the stock figure never shrinks,
                        so the name was squeezed to nothing and drawn under it.
                      */}
                      <div
                        className={cx(
                          "flex w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2.5 text-left transition-colors @lg:flex-nowrap",
                          index === highlight && !outOfStock
                            ? "border-brand-200 bg-brand-50"
                            : "border-slate-200 bg-white",
                          outOfStock
                            ? "opacity-55"
                            : "hover:border-brand-200 hover:bg-brand-50",
                        )}
                        onMouseEnter={() => setHighlight(index)}
                      >
                        {/*
                          Clicking a result opens the batch panel - the deliberate
                          path, where the lot and quantity are chosen. Enter from
                          the search box stays the express lane for the common
                          case of one unit off the FEFO lot.
                        */}
                        <button
                          type="button"
                          disabled={outOfStock}
                          onClick={() => setPicking(hit)}
                          className={cx(
                            "flex min-w-0 flex-1 basis-full items-center gap-3 text-left @lg:basis-0",
                            outOfStock && "cursor-not-allowed",
                          )}
                        >
                          <span
                            className={cx(
                              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-semibold",
                              outOfStock
                                ? "bg-rose-50 text-rose-700"
                                : "bg-brand-50 text-brand-800",
                            )}
                            aria-hidden="true"
                          >
                            {hit.name.slice(0, 1).toUpperCase()}
                          </span>

                          <div className="min-w-0 flex-1">
                            <p className="flex items-center gap-1.5 text-sm font-medium text-slate-900">
                              <span className="truncate">{hit.name}</span>
                              {hit.packSize ? (
                                <span className="shrink-0 font-normal text-slate-400">
                                  {hit.packSize}
                                </span>
                              ) : null}
                              {hit.requiresPrescription ? (
                                <Badge tone="amber" className="shrink-0">
                                  Rx
                                </Badge>
                              ) : null}
                            </p>
                            <p className="truncate text-xs text-slate-500">
                              {[hit.genericName, hit.manufacturer, pack]
                                .filter(Boolean)
                                .join(" · ") || "—"}
                            </p>
                          </div>
                        </button>

                        <div className="min-w-0 flex-1 pl-[3.25rem] text-left @lg:flex-none @lg:pl-0 @lg:text-right">
                          <p
                            className={cx(
                              "tnum text-sm font-semibold",
                              outOfStock
                                ? "text-rose-600"
                                : low
                                  ? "text-amber-700"
                                  : "text-emerald-700",
                            )}
                          >
                            {outOfStock
                              ? "Out of stock"
                              : describeStock(hit.stockQuantity, perStrip, hit.unit)}
                          </p>
                          {hit.nearestExpiry ? (
                            <p className="text-[11px] text-slate-400">
                              exp {formatExpiry(hit.nearestExpiry)}
                            </p>
                          ) : null}
                        </div>

                        {!outOfStock ? (
                          <button
                            type="button"
                            onClick={() => quickAdd(hit, 1)}
                            className="min-h-9 shrink-0 rounded-lg bg-white px-3 py-2 text-xs font-medium text-brand-800 ring-1 ring-brand-200 ring-inset hover:bg-brand-50 @lg:min-h-0 @lg:px-2 @lg:py-1.5 @lg:text-[10px]"
                          >
                            + 1 quick
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-slate-400">
                Type at least two letters, or scan a pack. Click a result to
                choose its batch; Enter adds one from the earliest expiry.
              </p>
            )}
          </div>

          {/* Cart */}
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-slate-900">Cart</h2>
                {/*
                  The counts are a subtitle, not part of the heading: they
                  change on every tap, and a title that grows and shrinks is
                  a title the eye stops trusting as an anchor.
                */}
                {cart.length > 0 ? (
                  <p className="truncate text-[11px] text-slate-500">
                    {cart.length} line{cart.length === 1 ? "" : "s"}
                    <span className="mx-1 text-slate-300">·</span>
                    {unitCount} item{unitCount === 1 ? "" : "s"}
                  </p>
                ) : null}
              </div>
              {cart.length > 0 ? (
                <button
                  type="button"
                  onClick={clearCart}
                  className="shrink-0 rounded-lg px-2 py-1.5 text-xs font-medium text-slate-500 hover:bg-rose-50 hover:text-rose-600"
                >
                  Clear all
                </button>
              ) : null}
            </div>

            {cart.length === 0 ? (
              <div className="px-4 py-16 text-center">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-700">
                  <svg
                    className="h-6 w-6"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.7}
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M3 7h18l-1.4 9.2A2 2 0 0117.62 18H8.38a2 2 0 01-1.98-1.8L5 7m0 0L4 4H2m6 14a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm9 0a1.5 1.5 0 100 3 1.5 1.5 0 000-3z"
                    />
                  </svg>
                </span>
                <p className="mt-3 text-sm font-medium text-slate-900">Cart is empty</p>
                <p className="mt-1 text-sm text-slate-500">
                  Search or scan above to add the first item.
                </p>
              </div>
            ) : (
              <ul className="@container divide-y divide-slate-100">
                {cart.map((line, index) => {
                  const planLine = planByKey.get(line.key);
                  const perStrip = line.unitsPerStrip || 1;
                  const pack = stripLabel(perStrip, line.unit);
                  const quantity = quantityFor(line);

                  // The bill's discount and VAT are struck on the whole cart,
                  // so a line's share of each is exactly its share of the
                  // subtotal. Shown per line because a customer asks "what did
                  // that one cost me?" - never used to compute the total.
                  const share =
                    plan && plan.subtotal > 0 && planLine
                      ? planLine.lineTotal / plan.subtotal
                      : 0;
                  const lineDiscount = plan ? plan.discount * share : 0;
                  const lineVat = plan ? plan.vatAmount * share : 0;
                  const linePayable = planLine
                    ? planLine.lineTotal - lineDiscount + lineVat
                    : 0;

                  // A pinned lot is a preference, not a reservation: another
                  // till can empty it, or it can expire, between the choice and
                  // the quote. The allocator quietly moves to the next valid
                  // batch, and the cashier is told rather than finding out from
                  // a batch number on the printed bill.
                  const pinHonoured =
                    line.batchId && planLine
                      ? planLine.picks.some((pick) => pick.batchId === line.batchId)
                      : null;

                  return (
                    <li key={line.key} className="px-4 py-3.5">
                      {/*
                        On a narrow cart the controls drop to their own line
                        under the name. Beside it they took ~250px, which on a
                        phone left the name one letter wide.
                      */}
                      <div className="flex flex-wrap items-start gap-x-3 gap-y-2.5 @lg:flex-nowrap">
                        <span className="tnum mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-500">
                          {index + 1}
                        </span>

                        <div className="min-w-0 flex-1 basis-[calc(100%-2.25rem)] @lg:basis-0">
                          <p className="text-sm font-medium text-slate-900">
                            {line.name}
                            {line.requiresPrescription ? (
                              <Badge tone="amber" className="ml-2">
                                Rx
                              </Badge>
                            ) : null}
                            {line.batchId ? (
                              <Badge
                                tone={pinHonoured === false ? "amber" : "brand"}
                                className="ml-2"
                              >
                                {pinHonoured === false ? "Lot changed" : "Chosen lot"}
                              </Badge>
                            ) : null}
                          </p>
                          <p className="text-xs text-slate-500">
                            {[pack, line.packSize].filter(Boolean).join(" · ") ||
                              unitWord(line.unit, 1)}
                          </p>

                          {/*
                            What was counted out, and what it came to once the
                            bill's share of discount and VAT is on it. Kept in
                            the name column so a line reads as one paragraph
                            rather than a sentence stranded under the controls.
                          */}
                          <p className="mt-1.5 text-xs text-slate-600">
                            {describeQuantity(quantity, perStrip, line.unit)}
                            {planLine && (lineDiscount > 0.004 || lineVat > 0.004) ? (
                              <span className="text-slate-400">
                                {lineDiscount > 0.004
                                  ? ` · less ${money(lineDiscount)} discount`
                                  : ""}
                                {lineVat > 0.004 ? ` · plus ${money(lineVat)} VAT` : ""}
                                {` = ${money(linePayable)}`}
                              </span>
                            ) : null}
                          </p>
                        </div>

                        {/*
                          Quantity, money, remove: the three things done to a
                          line, gathered into one right-hand column in the order
                          a cashier reaches for them.
                        */}
                        <div className="flex w-full items-start gap-2 pl-9 @lg:w-auto @lg:shrink-0 @lg:pl-0">
                          <div>
                            <p className="mb-1 text-center text-[10px] font-medium tracking-wide text-slate-400 uppercase">
                              {unitWord(line.unit, 2)}
                            </p>
                            <div className="flex items-center rounded-xl bg-slate-50 ring-1 ring-slate-200 ring-inset">
                              <button
                                type="button"
                                aria-label={`Decrease ${line.name}`}
                                onClick={() => setQuantity(line.key, line.quantity - 1)}
                                className="px-3.5 py-2 text-base text-slate-500 hover:text-slate-900 @lg:px-2.5 @lg:py-1.5 @lg:text-sm"
                              >
                                −
                              </button>
                              <input
                                type="number"
                                min={1}
                                max={line.stockQuantity}
                                value={qtyDraft[line.key] ?? String(line.quantity)}
                                onChange={(event) =>
                                  setQtyDraft((current) => ({
                                    ...current,
                                    [line.key]: event.target.value,
                                  }))
                                }
                                onBlur={(event) =>
                                  commitQuantity(
                                    line.key,
                                    event.target.value,
                                    line.stockQuantity,
                                  )
                                }
                                aria-label={`How many ${unitWord(line.unit, 2)} of ${line.name}`}
                                className="tnum w-12 border-0 bg-transparent py-1.5 text-center text-sm font-semibold focus:ring-0 focus:outline-none"
                              />
                              <button
                                type="button"
                                aria-label={`Increase ${line.name}`}
                                onClick={() => setQuantity(line.key, line.quantity + 1)}
                                className="px-3.5 py-2 text-base text-slate-500 hover:text-slate-900 @lg:px-2.5 @lg:py-1.5 @lg:text-sm"
                              >
                                +
                              </button>
                            </div>
                            {perStrip > 1 ? (
                              <button
                                type="button"
                                onClick={() =>
                                  setQuantity(line.key, line.quantity + perStrip)
                                }
                                disabled={line.quantity + perStrip > line.stockQuantity}
                                className="mt-1.5 w-full rounded-md px-1 py-1.5 text-xs font-medium text-brand-800 ring-1 ring-brand-200 ring-inset hover:bg-brand-50 disabled:opacity-40 @lg:mt-1 @lg:py-0.5 @lg:text-[10px]"
                              >
                                + 1 strip ({perStrip})
                              </button>
                            ) : null}
                          </div>

                          <div className="ml-auto w-24 shrink-0 pt-4 text-right @lg:ml-0">
                            <p className="tnum text-sm font-semibold text-slate-900">
                              {planLine ? money(planLine.lineTotal) : "—"}
                            </p>
                            {planLine && planLine.picks[0] ? (
                              <p className="tnum text-[11px] text-slate-400">
                                {money(planLine.picks[0].unitPrice)} each
                              </p>
                            ) : null}
                          </div>

                          <button
                            type="button"
                            aria-label={`Remove ${line.name}`}
                            onClick={() => removeLine(line.key)}
                            className="-mr-1 mt-3.5 rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600 @lg:mt-4 @lg:p-1.5"
                          >
                            <svg
                              className="h-4 w-4"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                            </svg>
                          </button>
                        </div>
                      </div>

                      {planLine ? (
                        <div className="mt-2 ml-9 space-y-1">
                          {planLine.picks.map((pick) => {
                            const days = Math.ceil(
                              (new Date(pick.expiryDate).getTime() - Date.now()) /
                                86_400_000,
                            );
                            return (
                              <div
                                key={pick.batchId}
                                className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs ring-1 ring-slate-100 ring-inset"
                              >
                                <span className="font-mono font-medium text-slate-700">
                                  {pick.batchNumber}
                                </span>
                                <span className="tnum text-slate-600">
                                  {formatUnitCount(pick.quantity, line.unit)} ×{" "}
                                  {money(pick.unitPrice)}
                                </span>
                                <span
                                  className={cx(
                                    "ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
                                    expiryTone(days),
                                  )}
                                >
                                  exp {formatExpiry(pick.expiryDate)} ·{" "}
                                  {describeExpiry(days)}
                                </span>
                              </div>
                            );
                          })}

                          {pinHonoured === false ? (
                            <p className="pl-1 text-[11px] font-medium text-amber-700">
                              The batch you chose is no longer available. This
                              line will be dispensed from the lots above.
                            </p>
                          ) : planLine.split ? (
                            <p className="pl-1 text-[11px] text-slate-500">
                              Split across {planLine.picks.length} batches,
                              earliest expiry first.
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
        <aside className="card sticky top-4 flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden">
          <div className="shrink-0 px-4 pt-4 pb-1">
            <h2 className="text-sm font-semibold text-slate-900">Checkout</h2>
            <p className="text-[11px] text-slate-500">
              Walk-in is fine. Name is required above Rs{" "}
              {IRD_BUYER_DETAIL_THRESHOLD.toLocaleString("en-NP")}.
            </p>
          </div>

          {/*
            The till's fields are steps, not a form: customer, then discount,
            then how it is being paid, then what was handed over. They are set
            apart by space alone - a rule between each was one line too many on
            a card this narrow, and the headings already do that work.
          */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <section className="space-y-3 px-4 py-3">
              <CustomerField
                name={customerName}
                customerId={customerId}
                phone={customerPhone}
                address={customerAddress}
                panNo={customerPan}
                canAdd={canAddCustomer}
                onChange={(next) => {
                  setCustomerName(next.name);
                  setCustomerId(next.customerId);
                  if (next.panNo !== undefined) setCustomerPan(next.panNo);
                  if (next.address !== undefined) setCustomerAddress(next.address);
                  if (next.phone !== undefined) setCustomerPhone(next.phone);
                }}
              />

              {/*
                Nearly every bill is a walk-in, so PAN, phone and address are
                folded away rather than asked for three times an hour. They open on
                their own once the bill crosses the IRD threshold that requires
                them, or when picking a saved customer has already filled them in -
                the counter never has to know to go looking.
              */}
              <details
                open={buyerDetailsNeeded}
                className="group rounded-xl border border-slate-200 bg-slate-50/60"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs font-medium text-slate-600 hover:text-slate-900">
                  <span>
                    Buyer details
                    {buyerDetailsFilled ? (
                      <span className="ml-1.5 font-normal text-slate-400">added</span>
                    ) : (
                      <span className="ml-1.5 font-normal text-slate-400">optional</span>
                    )}
                  </span>
                  <svg
                    className="h-4 w-4 transition-transform group-open:rotate-180"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                  </svg>
                </summary>

                <div className="space-y-3 border-t border-slate-200 bg-white/70 p-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label htmlFor="buyer-pan" className="label">
                        Buyer PAN
                      </label>
                      <input
                        id="buyer-pan"
                        inputMode="numeric"
                        maxLength={9}
                        value={customerPan}
                        onChange={(event) =>
                          setCustomerPan(event.target.value.replace(/\D/g, "").slice(0, 9))
                        }
                        placeholder="9 digits"
                        className="input tnum"
                      />
                    </div>
                    <div>
                      <label htmlFor="buyer-phone" className="label">
                        Phone
                      </label>
                      <input
                        id="buyer-phone"
                        value={customerPhone}
                        onChange={(event) => setCustomerPhone(event.target.value)}
                        className="input"
                      />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="buyer-address" className="label">
                      Buyer address
                    </label>
                    <input
                      id="buyer-address"
                      value={customerAddress}
                      onChange={(event) => setCustomerAddress(event.target.value)}
                      className="input"
                    />
                  </div>
                </div>
              </details>
            </section>

            {canDiscount ? (
              <section className="px-4 py-3">
                <span className="label">Discount</span>

                {/*
                  The counter almost always gives a round percentage, so those are
                  one tap. Picking one clears the rupee box and vice versa: two
                  live discount figures on one bill is a dispute waiting at the
                  till, and only one of them can be the one that was applied.
                */}
                <div className="grid grid-cols-5 gap-1.5">
                  {DISCOUNT_STEPS.map((step) => {
                    const active = percentValue === step;
                    return (
                      <button
                        key={step}
                        type="button"
                        onClick={() => {
                          setDiscountPercent(active ? "0" : String(step));
                          setDiscount("0");
                        }}
                        aria-pressed={active}
                        className={cx(
                          "tnum min-h-9 rounded-lg px-1 py-2 text-xs font-medium ring-1 transition-colors lg:min-h-0",
                          active
                            ? "bg-brand-600 text-white ring-brand-600"
                            : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50",
                        )}
                      >
                        {step === 0 ? "None" : `${step}%`}
                      </button>
                    );
                  })}
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div>
                    <label
                      htmlFor="discount-percent"
                      className="mb-1 block text-[11px] text-slate-500"
                    >
                      Custom %
                    </label>
                    <input
                      id="discount-percent"
                      type="number"
                      min={0}
                      max={100}
                      step="0.5"
                      value={discountPercent}
                      onChange={(event) => {
                        setDiscountPercent(event.target.value);
                        if (Number(event.target.value) > 0) setDiscount("0");
                      }}
                      className="input tnum"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="discount"
                      className="mb-1 block text-[11px] text-slate-500"
                    >
                      Or Rs
                    </label>
                    <input
                      id="discount"
                      type="number"
                      min={0}
                      step="0.01"
                      value={discount}
                      onChange={(event) => {
                        setDiscount(event.target.value);
                        if (Number(event.target.value) > 0) setDiscountPercent("0");
                      }}
                      className="input tnum"
                    />
                  </div>

                  {plan && plan.discountPercent > 0 ? (
                    <p className="tnum col-span-2 text-[11px] text-slate-500">
                      {plan.discountPercent}% of {money(plan.subtotal)} ={" "}
                      <span className="font-medium text-slate-700">
                        {money(plan.discount)}
                      </span>
                    </p>
                  ) : null}
                </div>
              </section>
            ) : null}

            <section className="px-4 py-3">
              <span className="label">Payment method</span>
              <div className="grid grid-cols-3 gap-1.5">
                {PAYMENT_MODES.filter(
                  (mode) => mode !== "credit" || canSellOnCredit,
                ).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      setPaymentMode(mode);
                      // Switching method resets the tendered figure to its
                      // default meaning for that method: nothing on credit,
                      // the exact total everywhere else. A "1500" left over
                      // from cash must not silently become a card amount.
                      setReceived("");
                    }}
                    aria-pressed={paymentMode === mode}
                    className={cx(
                      "flex flex-col items-center gap-1.5 rounded-xl px-1 py-2.5 text-[11px] font-medium ring-1 transition-colors",
                      paymentMode === mode
                        ? "bg-brand-600 text-white ring-brand-600"
                        : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50",
                    )}
                  >
                    <PaymentIcon mode={mode} />
                    {PAYMENT_MODE_LABELS[mode]}
                  </button>
                ))}
              </div>
            </section>

            {/*
              Amount received, and what it settles to.
              Offered on every method, because a part payment is possible on
              any of them, but left blank by default: on anything but credit an
              empty box means the customer paid what was asked, which is what a
              cashier tabbing past it intends. The quick-cash notes only appear
              where notes are actually counted.

              The breakdown sits directly under the box rather than further down
              the column, so the figure and its verdict are read in one glance -
              "is this bill going to be marked unpaid?" is a question to answer
              before the money moves, not after.
            */}
            <section className="space-y-3 px-4 py-3">
              <div>
                <label htmlFor="received" className="label">
                  {onCredit ? "Paid now" : "Amount received"}{" "}
                  <span className="font-normal text-slate-400">
                    {onCredit ? "leave blank for none" : "leave blank for exact"}
                  </span>
                </label>
                <input
                  id="received"
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  value={received}
                  onChange={(event) => setReceived(event.target.value)}
                  placeholder={
                    onCredit ? "0.00" : total > 0 ? total.toFixed(2) : "0.00"
                  }
                  className="input tnum"
                />

                {isCash || onCredit ? (
                  <div className="mt-1.5 grid grid-cols-5 gap-1.5">
                    <button
                      type="button"
                      onClick={() => setReceived(total > 0 ? total.toFixed(2) : "")}
                      className="min-h-9 rounded-lg bg-white px-1 py-2 text-xs font-medium text-slate-600 ring-1 ring-slate-200 ring-inset hover:bg-slate-50 lg:min-h-0 lg:py-1.5 lg:text-[10px]"
                    >
                      Exact
                    </button>
                    {CASH_STEPS.map((step) => (
                      <button
                        key={step}
                        type="button"
                        onClick={() =>
                          setReceived(String((Number(received) || 0) + step))
                        }
                        className="tnum min-h-9 rounded-lg bg-white px-1 py-2 text-xs font-medium text-slate-600 ring-1 ring-slate-200 ring-inset hover:bg-slate-50 lg:min-h-0 lg:py-1.5 lg:text-[10px]"
                      >
                        +{step}
                      </button>
                    ))}
                  </div>
                ) : null}

                {received.trim() !== "" ? (
                  <button
                    type="button"
                    onClick={() => setReceived("")}
                    className="mt-1.5 text-[11px] font-medium text-slate-500 hover:text-slate-900"
                  >
                    Clear
                  </button>
                ) : null}
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                  <span className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
                    Payment
                  </span>
                  <PaymentStatusBadge status={settlement.status} />
                </div>

                <dl className="mt-2 space-y-1">
                  <Row label="Total due" value={money(settlement.totalDue)} />
                  <Row label="Paid" value={money(settlement.paid)} />
                  {settlement.remaining > 0 ? (
                    <Row
                      label="Remaining"
                      value={money(settlement.remaining)}
                      className="font-semibold text-amber-700"
                    />
                  ) : (
                    <Row label="Remaining" value={money(0)} />
                  )}
                  {changeDue > 0 ? (
                    <Row
                      label="Change"
                      value={money(changeDue)}
                      className="font-semibold text-emerald-700"
                    />
                  ) : null}
                </dl>
              </div>

              {overTendered ? (
                <p
                  role="status"
                  className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
                >
                  {money(settlement.change)} more than the total.{" "}
                  {PAYMENT_MODE_LABELS[paymentMode]} is taken for the exact
                  amount, so there is no change to hand back — correct the figure
                  or take the difference in cash.
                </p>
              ) : null}

              {settlement.remaining > 0 ? (
                <p
                  className={cx(
                    "rounded-lg border px-3 py-2 text-xs",
                    paymentBlocked
                      ? "border-rose-200 bg-rose-50 text-rose-700"
                      : "border-amber-200 bg-amber-50 text-amber-800",
                  )}
                  role={paymentBlocked ? "alert" : "status"}
                >
                  {paymentBlocked
                    ? `That is ${money(settlement.remaining)} short of the total, and you are not allowed to let a bill leave unpaid.`
                    : customerName.trim()
                      ? `${money(settlement.remaining)} will be recorded as a due against ${customerName.trim()}.`
                      : `${money(settlement.remaining)} will be left owing, with no customer to chase it from. Name the customer above.`}
                </p>
              ) : null}
            </section>

            <section className="px-4 py-3">
              <label htmlFor="sale-note" className="label">
                Note <span className="font-normal text-slate-400">optional</span>
              </label>
              <input
                id="sale-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={300}
                placeholder="Prescription ref, doctor, delivery…"
                className="input"
              />
            </section>
          </div>

          {/*
            The foot of the till. Subtotal and VAT are the working, the tinted
            panel is the answer, and the button is the act - one block, ruled
            off from the fields above, so the eye runs down them in that order
            without the page moving under it.
          */}
          <div className="shrink-0 border-t border-slate-200">
            <div className="space-y-2 px-4 pt-3 pb-2">
              <Row label="Subtotal" value={plan ? money(plan.subtotal) : "—"} />
              {plan && plan.discount > 0 ? (
                <Row
                  label={
                    plan.discountPercent > 0
                      ? `Discount (${plan.discountPercent}%)`
                      : "Discount"
                  }
                  value={`− ${money(plan.discount)}`}
                  className="text-rose-600"
                />
              ) : null}
              <Row
                label={`VAT (${plan ? Math.round(plan.vatRate * 100) : 13}%)`}
                value={plan ? money(plan.vatAmount) : "—"}
              />
              {quoting ? (
                <p className="text-right text-[11px] text-slate-400">Updating…</p>
              ) : null}
            </div>

            {/*
              The answer, in the brand tint rather than the dark slate the hero
              uses. Two dark panels on one screen fought each other for the
              cashier's eye; this one only has to out-weigh the two grey rows
              directly above it, and a tint does that on its own.
            */}
            <div className="mx-4 rounded-xl bg-brand-50 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold tracking-[0.14em] text-brand-800 uppercase">
                    Total due
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {PAYMENT_MODE_LABELS[paymentMode]}
                    {unitCount > 0
                      ? ` · ${unitCount} item${unitCount === 1 ? "" : "s"}`
                      : ""}
                  </p>
                </div>
                <p className="tnum text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
                  {money(total)}
                </p>
              </div>
            </div>

            <div className="space-y-3 px-4 pt-3 pb-4">
              {planError ? (
                <div
                  role="alert"
                  className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
                >
                  {planError}
                </div>
              ) : null}

              {buyerNameMissing ? (
                <div
                  role="status"
                  className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
                >
                  IRD requires the buyer&apos;s name (and PAN if they have one) on
                  bills of Rs {IRD_BUYER_DETAIL_THRESHOLD.toLocaleString("en-NP")}{" "}
                  or more. Add them above before completing.
                </div>
              ) : null}

              {submitError ? (
                <div
                  role="alert"
                  className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
                >
                  {submitError}
                </div>
              ) : null}

              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={!readyToConfirm}
                className="btn-primary hidden w-full py-3.5 text-base shadow-lg shadow-brand-900/10 lg:flex"
              >
                Complete Sale
                <kbd className="rounded bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold">
                  F9
                </kbd>
              </button>

              <p className="hidden text-center text-[11px] text-slate-400 lg:block">
                Billed by {cashierName}
              </p>
            </div>
          </div>
        </aside>

        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 px-3 pt-2 pb-[max(0.75rem,var(--safe-bottom))] backdrop-blur lg:hidden">
          {planError ? (
            <p className="mb-2 line-clamp-2 text-[11px] text-amber-800">{planError}</p>
          ) : null}
          {submitError ? (
            <p className="mb-2 line-clamp-2 text-[11px] text-rose-700">{submitError}</p>
          ) : null}
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={!readyToConfirm}
            className="btn-primary w-full py-3.5 text-base"
          >
            {plan ? `Complete Sale · ${money(total)}` : "Complete Sale"}
          </button>
        </div>
      </div>

      {confirming && plan ? (
        <ConfirmSale
          plan={plan}
          customerName={customerName}
          customerPhone={customerPhone}
          paymentMode={paymentMode}
          amountReceived={receivedValue}
          outletName={outletName}
          cashierName={cashierName}
          submitting={submitting}
          onConfirm={completeSale}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </>
  );
}

function Row({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={cx("flex items-center justify-between text-sm", className)}>
      <span className="text-slate-600">{label}</span>
      <span className="tnum font-medium">{value}</span>
    </div>
  );
}

/**
 * Paid / Partially paid / Credit-Unpaid, in the tones the rest of the app
 * already uses for good, watch-this and needs-chasing.
 */
export function PaymentStatusBadge({
  status,
  className,
}: {
  status: PaymentStatus;
  className?: string;
}) {
  const tone =
    status === "paid" ? "green" : status === "partial" ? "amber" : "rose";
  return (
    <Badge tone={tone} className={className}>
      {PAYMENT_STATUS_LABELS[status]}
    </Badge>
  );
}

function Kbd({ hint, children }: { hint: string; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-2 py-1 ring-1 ring-white/10 ring-inset">
      <kbd className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-semibold">
        {hint}
      </kbd>
      {children}
    </span>
  );
}

function PaymentIcon({ mode }: { mode: PaymentMode }) {
  const path =
    mode === "cash"
      ? "M3 7h18v10H3zM3 11h18M7 15h2"
      : mode === "card"
        ? "M3 8h18v10H3zM3 11h18"
        : mode === "bank"
          ? "M3 10h18L12 4 3 10zm2 0v7m4-7v7m6-7v7m4-7v7M3 20h18"
          : mode === "credit"
            ? "M8 7h8M6 11h12M6 15h8M6 4v16"
            : "M4 7h16v11H4zM8 7V5a4 4 0 018 0v2";

  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.8}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}
