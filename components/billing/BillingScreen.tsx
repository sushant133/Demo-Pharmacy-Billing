"use client";

import { useRouter } from "next/navigation";
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
import { Badge, cx } from "@/components/ui";
import { CustomerField } from "@/components/billing/CustomerField";
import {
  IRD_BUYER_DETAIL_THRESHOLD,
  PAYMENT_MODES,
  PAYMENT_MODE_LABELS,
  type PaymentMode,
} from "@/lib/constants";
import type { SalePlan } from "@/lib/sales";

/**
 * The POS screen.
 *
 * Client component by necessity: search-as-you-type, a live cart, and totals
 * that update on every keystroke. Everything it renders comes from two
 * endpoints - /api/medicines for the search and /api/sales/quote for the
 * authoritative FEFO plan.
 *
 * Totals are never computed here. The server owns pricing and VAT, so the
 * number the cashier reads is always the number that will be charged.
 */

interface MedicineHit {
  id: string;
  name: string;
  genericName: string;
  manufacturer: string;
  unit: string;
  packSize: string;
  requiresPrescription: boolean;
  stockQuantity: number;
  nearestExpiry: string | null;
}

interface CartLine {
  medicineId: string;
  name: string;
  unit: string;
  requiresPrescription: boolean;
  quantity: number;
  stockQuantity: number;
}

/**
 * One-tap discounts, in the sizes a pharmacy counter actually gives.
 * "None" is first so clearing one is as quick as setting it.
 */
const DISCOUNT_STEPS = [0, 5, 10, 15, 20] as const;

export function BillingScreen({
  cashierName,
  outletName,
}: {
  cashierName: string;
  outletName: string;
}) {
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MedicineHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState("0");
  const [discountPercent, setDiscountPercent] = useState("0");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("cash");
  const [customerName, setCustomerName] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerPan, setCustomerPan] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [note, setNote] = useState("");

  const [plan, setPlan] = useState<SalePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
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

    // Debounced so a fast typist fires one request, not eight.
    const timer = setTimeout(async () => {
      const result = await apiFetch<MedicineHit[]>(
        "/api/medicines" + qs({ q: term, withStock: "1", pageSize: 8 }),
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setHits(result.ok ? result.data : []);
      setHighlight(0);
      setSearching(false);
    }, 180);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [deferredQuery]);

  // --- Live quote ---------------------------------------------------------
  const cartKey = useMemo(
    () => cart.map((line) => `${line.medicineId}:${line.quantity}`).join("|"),
    [cart],
  );
  const discountValue = Number(discount) || 0;
  // A percentage is resolved on the server, which is the only side that knows
  // what the lines came to once FEFO has split them across batches.
  const percentValue = Number(discountPercent) || 0;

  useEffect(() => {
    if (cart.length === 0) {
      setPlan(null);
      setPlanError(null);
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
            quantity: line.quantity,
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
    // cartKey captures the meaningful shape of `cart` for this effect.
  }, [cartKey, discountValue, percentValue, cart]);

  // --- Cart operations ----------------------------------------------------
  const addToCart = useCallback((medicine: MedicineHit) => {
    setCart((current) => {
      const existing = current.find((line) => line.medicineId === medicine.id);
      if (existing) {
        return current.map((line) =>
          line.medicineId === medicine.id
            ? { ...line, quantity: line.quantity + 1 }
            : line,
        );
      }
      return [
        ...current,
        {
          medicineId: medicine.id,
          name: medicine.name,
          unit: medicine.unit,
          requiresPrescription: medicine.requiresPrescription,
          quantity: 1,
          stockQuantity: medicine.stockQuantity,
        },
      ];
    });

    setQuery("");
    setHits([]);
    searchRef.current?.focus();
  }, []);

  const setQuantity = useCallback((medicineId: string, quantity: number) => {
    setCart((current) =>
      current.map((line) =>
        line.medicineId === medicineId
          ? { ...line, quantity: Math.max(1, Math.floor(quantity) || 1) }
          : line,
      ),
    );
  }, []);

  const removeLine = useCallback((medicineId: string) => {
    setCart((current) => current.filter((line) => line.medicineId !== medicineId));
  }, []);

  function clearCart() {
    setCart([]);
    setDiscount("0");
    setDiscountPercent("0");
    setCustomerName("");
    setCustomerId(null);
    setCustomerPan("");
    setCustomerAddress("");
    setCustomerPhone("");
    setNote("");
    setPlan(null);
    setPlanError(null);
    setSubmitError(null);
    searchRef.current?.focus();
  }

  // --- Submit -------------------------------------------------------------
  async function completeSale() {
    if (cart.length === 0 || submitting) return;
    setSubmitting(true);
    setSubmitError(null);

    const result = await apiFetch<{ id: string; billNo: string }>("/api/sales", {
      method: "POST",
      json: {
        items: cart.map((line) => ({
          medicineId: line.medicineId,
          quantity: line.quantity,
        })),
        customerId,
        customerName: customerName.trim(),
        customerPan: customerPan.trim(),
        customerAddress: customerAddress.trim(),
        customerPhone: customerPhone.trim(),
        discount: discountValue,
        discountPercent: percentValue,
        paymentMode,
        note: note.trim(),
      },
    });

    if (!result.ok) {
      setSubmitError(result.message);
      setSubmitting(false);
      return;
    }

    // Straight to the printable bill; the cashier's next action is always
    // "hand the customer their receipt".
    router.push(`/bills/${result.data.id}?print=1`);
  }

  // --- Keyboard shortcuts -------------------------------------------------
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "F4") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      // F9 completes the sale from anywhere on the screen.
      if (event.key === "F9" && plan && !submitting) {
        event.preventDefault();
        void completeSale();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
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
      if (hit && hit.stockQuantity > 0) addToCart(hit);
    } else if (event.key === "Escape") {
      setHits([]);
      setQuery("");
    }
  }

  const picksByMedicine = useMemo(() => {
    const map = new Map<string, SalePlan["lines"][number]>();
    for (const line of plan?.lines ?? []) map.set(line.medicineId, line);
    return map;
  }, [plan]);

  const unitCount = cart.reduce((sum, line) => sum + line.quantity, 0);

  // Anything already typed, or pulled in with a saved customer, keeps the
  // buyer panel open so it never hides a value the counter can see is wrong.
  const buyerDetailsFilled = Boolean(
    customerPan.trim() || customerPhone.trim() || customerAddress.trim(),
  );
  const buyerDetailsNeeded =
    buyerDetailsFilled ||
    Boolean(plan && plan.totalAmount >= IRD_BUYER_DETAIL_THRESHOLD);

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
              Batches are chosen automatically — earliest expiry first, never an
              expired one.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <div className="hidden sm:flex items-center gap-2 text-[11px] text-slate-300">
              <Kbd hint="F4">Search</Kbd>
              <Kbd hint="F9">Complete</Kbd>
            </div>
            <div className="text-right">
              <p className="text-[11px] font-semibold tracking-[0.14em] text-brand-300 uppercase">
                This bill
              </p>
              <p className="tnum mt-0.5 text-3xl font-semibold tracking-tight">
                {plan ? money(plan.totalAmount) : money(0)}
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
      <div className="space-y-4">
        <div className="card p-4 sm:p-5">
          <label htmlFor="medicine-search" className="label">
            Search medicine
            <span className="ml-2 font-normal text-slate-400">
              name, generic or salt
            </span>
          </label>

          <div className="relative">
            <svg
              className="pointer-events-none absolute top-1/2 left-3.5 h-5 w-5 -translate-y-1/2 text-slate-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" d="M21 21l-4.3-4.3M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
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
              placeholder="Start typing a name… (F4)"
              className="pos-search"
              role="combobox"
              aria-expanded={hits.length > 0}
              aria-controls="medicine-results"
            />

            <kbd className="absolute top-1/2 right-3 -translate-y-1/2 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 ring-1 ring-slate-200 ring-inset">
              F4
            </kbd>
          </div>

          {query.trim().length >= 2 ? (
            <ul
              id="medicine-results"
              role="listbox"
              className="mt-3 max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50/40"
            >
              {searching && hits.length === 0 ? (
                <li className="px-4 py-5 text-sm text-slate-500">Searching…</li>
              ) : null}

              {!searching && hits.length === 0 ? (
                <li className="px-4 py-5 text-sm text-slate-500">
                  No medicine matches “{query.trim()}”.
                </li>
              ) : null}

              {hits.map((hit, index) => {
                const outOfStock = hit.stockQuantity <= 0;
                const low = !outOfStock && hit.stockQuantity <= 10;
                return (
                  <li key={hit.id} role="option" aria-selected={index === highlight}>
                    <button
                      type="button"
                      disabled={outOfStock}
                      onMouseEnter={() => setHighlight(index)}
                      onClick={() => addToCart(hit)}
                      className={cx(
                        "flex w-full items-center gap-3 px-3 py-3 text-left transition-colors",
                        index === highlight && !outOfStock && "bg-brand-50",
                        outOfStock ? "cursor-not-allowed opacity-55" : "hover:bg-brand-50",
                      )}
                    >
                      <span
                        className={cx(
                          "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-semibold",
                          outOfStock
                            ? "bg-rose-50 text-rose-700"
                            : "bg-brand-50 text-brand-800",
                        )}
                        aria-hidden="true"
                      >
                        {hit.name.slice(0, 1).toUpperCase()}
                      </span>

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-900">
                          {hit.name}
                          {hit.packSize ? (
                            <span className="ml-1.5 font-normal text-slate-400">
                              {hit.packSize}
                            </span>
                          ) : null}
                        </p>
                        <p className="truncate text-xs text-slate-500">
                          {[hit.genericName, hit.manufacturer].filter(Boolean).join(" · ") ||
                            "—"}
                        </p>
                      </div>

                      {hit.requiresPrescription ? (
                        <Badge tone="amber" className="hidden sm:inline-flex">
                          Rx
                        </Badge>
                      ) : null}

                      <div className="shrink-0 text-right">
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
                          {outOfStock ? "Out of stock" : `${hit.stockQuantity} left`}
                        </p>
                        {hit.nearestExpiry ? (
                          <p className="text-[11px] text-slate-400">
                            exp {formatExpiry(hit.nearestExpiry)}
                          </p>
                        ) : null}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-slate-400">
              Type at least two letters. Enter adds the highlighted row.
            </p>
          )}
        </div>

        {/* Cart */}
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/70 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-900">
              Cart
              {cart.length > 0 ? (
                <span className="ml-2 font-normal text-slate-500">
                  {cart.length} line{cart.length === 1 ? "" : "s"}
                  <span className="mx-1 text-slate-300">·</span>
                  {unitCount} item{unitCount === 1 ? "" : "s"}
                </span>
              ) : null}
            </h2>
            {cart.length > 0 ? (
              <button
                type="button"
                onClick={clearCart}
                className="text-xs font-medium text-slate-500 hover:text-rose-600"
              >
                Clear all
              </button>
            ) : null}
          </div>

          {cart.length === 0 ? (
            <div className="px-4 py-16 text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-700">
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h18l-1.4 9.2A2 2 0 0117.62 18H8.38a2 2 0 01-1.98-1.8L5 7m0 0L4 4H2m6 14a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm9 0a1.5 1.5 0 100 3 1.5 1.5 0 000-3z" />
                </svg>
              </span>
              <p className="mt-3 text-sm font-medium text-slate-900">Cart is empty</p>
              <p className="mt-1 text-sm text-slate-500">
                Search above and press Enter to add the first item.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {cart.map((line, index) => {
                const planLine = picksByMedicine.get(line.medicineId);
                return (
                  <li key={line.medicineId} className="px-4 py-3.5">
                    <div className="flex items-start gap-3">
                      <span className="tnum mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-500">
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-slate-900">
                          {line.name}
                          {line.requiresPrescription ? (
                            <Badge tone="amber" className="ml-2">
                              Rx
                            </Badge>
                          ) : null}
                        </p>
                        <p className="text-xs text-slate-500 capitalize">{line.unit}</p>
                      </div>

                      <div className="flex items-center rounded-xl bg-slate-50 ring-1 ring-slate-200 ring-inset">
                        <button
                          type="button"
                          aria-label={`Decrease ${line.name}`}
                          onClick={() => setQuantity(line.medicineId, line.quantity - 1)}
                          className="px-2.5 py-1.5 text-slate-500 hover:text-slate-900"
                        >
                          −
                        </button>
                        <input
                          type="number"
                          min={1}
                          value={line.quantity}
                          onChange={(event) =>
                            setQuantity(line.medicineId, Number(event.target.value))
                          }
                          aria-label={`Quantity for ${line.name}`}
                          className="tnum w-12 border-0 bg-transparent py-1.5 text-center text-sm font-semibold focus:ring-0 focus:outline-none"
                        />
                        <button
                          type="button"
                          aria-label={`Increase ${line.name}`}
                          onClick={() => setQuantity(line.medicineId, line.quantity + 1)}
                          className="px-2.5 py-1.5 text-slate-500 hover:text-slate-900"
                        >
                          +
                        </button>
                      </div>

                      <div className="w-24 shrink-0 text-right">
                        <p className="tnum text-sm font-semibold text-slate-900">
                          {planLine ? money(planLine.lineTotal) : "—"}
                        </p>
                      </div>

                      <button
                        type="button"
                        aria-label={`Remove ${line.name}`}
                        onClick={() => removeLine(line.medicineId)}
                        className="-mr-1 rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
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
                                {pick.quantity} × {money(pick.unitPrice)}
                              </span>
                              <span
                                className={cx(
                                  "ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
                                  expiryTone(days),
                                )}
                              >
                                exp {formatExpiry(pick.expiryDate)} · {describeExpiry(days)}
                              </span>
                            </div>
                          );
                        })}

                        {planLine.split ? (
                          <p className="pl-1 text-[11px] text-slate-500">
                            Split across {planLine.picks.length} batches, earliest
                            expiry first.
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

      {/*
        The till column is a fixed frame, not a long page: the fields scroll
        inside it while the total and Complete sale stay pinned to the bottom.
        Before this the action sat below the fold on a laptop, so finishing a
        sale meant scrolling away from the cart to find the button - the one
        thing on a counter screen that should never need looking for.
      */}
      <aside className="card sticky top-4 flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden">
        <div className="shrink-0 border-b border-slate-100 bg-slate-50/70 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">Checkout</h2>
          <p className="text-[11px] text-slate-500">
            Walk-in is fine. Name is required above Rs{" "}
            {IRD_BUYER_DETAIL_THRESHOLD.toLocaleString("en-NP")}.
          </p>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <CustomerField
            name={customerName}
            customerId={customerId}
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
            className="group rounded-lg border border-slate-200 bg-slate-50/60"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900">
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

            <div className="space-y-3 border-t border-slate-200 p-3">
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

          <div>
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
                      "tnum rounded-lg px-1 py-2 text-xs font-medium ring-1 transition-colors",
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
            </div>

            {plan && plan.discountPercent > 0 ? (
              <p className="tnum mt-1.5 text-[11px] text-slate-500">
                {plan.discountPercent}% of {money(plan.subtotal)} ={" "}
                <span className="font-medium text-slate-700">
                  {money(plan.discount)}
                </span>
              </p>
            ) : null}
          </div>

          <div>
            <span className="label">Payment mode</span>
            <div className="grid grid-cols-5 gap-1.5">
              {PAYMENT_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setPaymentMode(mode)}
                  aria-pressed={paymentMode === mode}
                  className={cx(
                    "flex flex-col items-center gap-1 rounded-xl px-1 py-2 text-[11px] font-medium ring-1 transition-colors",
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
          </div>
        </div>

        <div className="shrink-0 space-y-2 border-t border-slate-100 px-4 py-4">
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

        <div className="pos-till relative mx-3 mb-3 shrink-0 overflow-hidden rounded-xl px-4 py-3 text-white">
          <div className="login-blister absolute inset-0 opacity-50" aria-hidden="true" />
          <div className="relative flex items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold tracking-[0.14em] text-brand-300 uppercase">
                Total due
              </p>
              <p className="mt-0.5 text-[11px] text-slate-300">
                {PAYMENT_MODE_LABELS[paymentMode]}
                {unitCount > 0 ? ` · ${unitCount} item${unitCount === 1 ? "" : "s"}` : ""}
              </p>
            </div>
            <p className="tnum text-2xl font-semibold tracking-tight sm:text-3xl">
              {plan ? money(plan.totalAmount) : money(0)}
            </p>
          </div>
        </div>

        <div className="shrink-0 space-y-3 px-4 pb-4">
          {planError ? (
            <div
              role="alert"
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
            >
              {planError}
            </div>
          ) : null}

          {plan &&
          plan.totalAmount >= IRD_BUYER_DETAIL_THRESHOLD &&
          !customerName.trim() ? (
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
            onClick={completeSale}
            disabled={!plan || submitting || cart.length === 0}
            className="btn-primary w-full py-3.5 text-base shadow-lg shadow-brand-900/10"
          >
            {submitting ? "Completing…" : "Complete sale"}
            {!submitting ? (
              <kbd className="rounded bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold">
                F9
              </kbd>
            ) : null}
          </button>

          <p className="text-center text-[11px] text-slate-400">
            Billed by {cashierName}
          </p>
        </div>
      </aside>
    </div>
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

function Kbd({ hint, children }: { hint: string; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-2 py-1 ring-1 ring-white/10 ring-inset">
      <kbd className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-semibold">{hint}</kbd>
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
        : mode === "credit"
          ? "M8 7h8M6 11h12M6 15h8M6 4v16"
          : "M4 7h16v11H4zM8 7V5a4 4 0 018 0v2";

  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}
