"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/client";
import { toDateInputValue } from "@/lib/dates";
import { DualDateField } from "@/components/DualDateField";
import { Field, SlideOver } from "@/components/SlideOver";
import { cx } from "@/components/ui";

/**
 * File a doctor's prescription.
 *
 * The shape follows the piece of paper: who it is for, who wrote it, when, and
 * then the medicines. Staff enter these with the script in one hand, so the
 * order on screen matches the order they read it off - anything else turns
 * filing into a hunt.
 *
 * The patient may be an existing customer or a typed name. A script is often
 * written for somebody the shop has never billed, and refusing to file it
 * until they are on the register would mean it does not get filed at all.
 */

interface MedicineHit {
  id: string;
  name: string;
  genericName: string;
  unit: string;
  requiresPrescription: boolean;
}

interface CustomerHit {
  id: string;
  name: string;
  phone: string;
}

interface Line {
  /** Blank until a medicine is chosen from the search list. */
  medicineId: string;
  medicineName: string;
  requiresPrescription: boolean;
  unit: string;
  dosage: string;
  quantity: string;
  notes: string;
}

const emptyLine = (): Line => ({
  medicineId: "",
  medicineName: "",
  requiresPrescription: false,
  unit: "unit",
  dosage: "",
  quantity: "",
  notes: "",
});

export function PrescriptionFormPanel({ returnHref = "/prescriptions" }: { returnHref?: string }) {
  const router = useRouter();

  const today = toDateInputValue();
  const [patientName, setPatientName] = useState("");
  const [patientPhone, setPatientPhone] = useState("");
  const [patientAge, setPatientAge] = useState("");
  const [patientGender, setPatientGender] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);

  const [doctorName, setDoctorName] = useState("");
  const [doctorRegNo, setDoctorRegNo] = useState("");
  const [hospital, setHospital] = useState("");

  const [issuedOn, setIssuedOn] = useState(today);
  const [validUntil, setValidUntil] = useState("");

  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [copyHeld, setCopyHeld] = useState(false);
  const [notes, setNotes] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  const close = useCallback(() => {
    router.push(returnHref);
    router.refresh();
  }, [router, returnHref]);

  function setLine(index: number, patch: Partial<Line>) {
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  }

  const ready =
    patientName.trim().length >= 2 &&
    doctorName.trim().length >= 2 &&
    issuedOn &&
    lines.some((line) => line.medicineId && Number(line.quantity) > 0);

  async function save() {
    if (inflight.current || !ready) return;
    inflight.current = true;
    setSaving(true);
    setError(null);

    const items = lines
      .filter((line) => line.medicineId && Number(line.quantity) > 0)
      .map((line) => ({
        medicineId: line.medicineId,
        dosage: line.dosage.trim(),
        quantityPrescribed: Number(line.quantity),
        notes: line.notes.trim(),
      }));

    const result = await apiFetch("/api/prescriptions", {
      method: "POST",
      json: {
        customerId,
        patientName: patientName.trim(),
        patientPhone: patientPhone.trim(),
        patientAge: patientAge.trim(),
        patientGender,
        doctorName: doctorName.trim(),
        doctorRegNo: doctorRegNo.trim(),
        hospital: hospital.trim(),
        issuedOn,
        validUntil: validUntil || "",
        items,
        copyHeld,
        notes: notes.trim(),
      },
    });

    inflight.current = false;
    setSaving(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    close();
  }

  return (
    <SlideOver
      title="File a prescription"
      description="What the doctor wrote, and for whom. Dispensing against it is recorded afterwards."
      onClose={close}
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving || !ready}
            className="btn-primary flex-1"
          >
            {saving ? "Filing…" : "File prescription"}
          </button>
          <button type="button" onClick={close} className="btn-secondary">
            Cancel
          </button>
        </div>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="space-y-5"
      >
        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          >
            {error}
          </div>
        ) : null}

        <fieldset className="space-y-4">
          <legend className="w-full border-b border-slate-100 pb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Patient
          </legend>

          <PatientSearch
            onPick={(customer) => {
              setCustomerId(customer.id);
              setPatientName(customer.name);
              setPatientPhone(customer.phone);
            }}
          />

          <Field label="Name" htmlFor="patientName" required>
            <input
              id="patientName"
              value={patientName}
              onChange={(event) => {
                setPatientName(event.target.value);
                // Typing over a picked customer detaches the link: the script
                // is for whoever is named on it, not whoever was searched for.
                setCustomerId(null);
              }}
              placeholder="As written on the prescription"
              className="input"
              required
            />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Phone" htmlFor="patientPhone">
              <input
                id="patientPhone"
                value={patientPhone}
                onChange={(event) => setPatientPhone(event.target.value)}
                className="input tnum"
              />
            </Field>

            <Field label="Age" htmlFor="patientAge" hint="e.g. 34, 8 months">
              <input
                id="patientAge"
                value={patientAge}
                onChange={(event) => setPatientAge(event.target.value)}
                className="input"
              />
            </Field>

            <Field label="Sex" htmlFor="patientGender">
              <select
                id="patientGender"
                value={patientGender}
                onChange={(event) => setPatientGender(event.target.value)}
                className="input"
              >
                <option value="">—</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="other">Other</option>
              </select>
            </Field>
          </div>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="w-full border-b border-slate-100 pb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Prescriber
          </legend>

          <Field label="Doctor" htmlFor="doctorName" required>
            <input
              id="doctorName"
              value={doctorName}
              onChange={(event) => setDoctorName(event.target.value)}
              placeholder="e.g. Dr Anjana Shrestha"
              className="input"
              required
            />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="NMC reg. no"
              htmlFor="doctorRegNo"
              hint="What makes a prescriber checkable."
            >
              <input
                id="doctorRegNo"
                value={doctorRegNo}
                onChange={(event) => setDoctorRegNo(event.target.value)}
                className="input tnum"
              />
            </Field>

            <Field label="Hospital or clinic" htmlFor="hospital">
              <input
                id="hospital"
                value={hospital}
                onChange={(event) => setHospital(event.target.value)}
                className="input"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <p className="label">Written on</p>
              <DualDateField
                id="issuedOn"
                value={issuedOn}
                onChange={setIssuedOn}
                compact
                aria-label="Written on"
              />
            </div>
            <div>
              <p className="label">
                Valid until{" "}
                <span className="font-normal text-slate-400">(optional)</span>
              </p>
              <DualDateField
                id="validUntil"
                value={validUntil}
                onChange={setValidUntil}
                compact
                aria-label="Valid until"
              />
            </div>
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="w-full border-b border-slate-100 pb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Medicines
          </legend>

          {lines.map((line, index) => (
            <div
              key={index}
              className="rounded-lg border border-slate-200 bg-slate-50/60 p-3"
            >
              {line.medicineId ? (
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {line.medicineName}
                      {line.requiresPrescription ? (
                        <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                          Rx
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setLine(index, emptyLine())}
                    className="shrink-0 text-xs font-medium text-brand-700 hover:underline"
                  >
                    Change
                  </button>
                </div>
              ) : (
                <MedicineSearch
                  index={index}
                  onPick={(hit) =>
                    setLine(index, {
                      medicineId: hit.id,
                      medicineName: hit.name,
                      requiresPrescription: hit.requiresPrescription,
                      unit: hit.unit,
                    })
                  }
                />
              )}

              {line.medicineId ? (
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Field label="Dosage" htmlFor={`dosage-${index}`} className="col-span-2">
                    <input
                      id={`dosage-${index}`}
                      value={line.dosage}
                      onChange={(event) =>
                        setLine(index, { dosage: event.target.value })
                      }
                      placeholder="1-0-1 after food, 5 days"
                      className="input"
                    />
                  </Field>
                  <Field label={`Qty (${line.unit})`} htmlFor={`qty-${index}`}>
                    <input
                      id={`qty-${index}`}
                      type="number"
                      min={1}
                      step={1}
                      value={line.quantity}
                      onChange={(event) =>
                        setLine(index, { quantity: event.target.value })
                      }
                      className="input tnum"
                    />
                  </Field>
                </div>
              ) : null}

              {lines.length > 1 ? (
                <button
                  type="button"
                  onClick={() =>
                    setLines((current) => current.filter((_, i) => i !== index))
                  }
                  className="mt-2 text-xs font-medium text-rose-600 hover:underline"
                >
                  Remove this line
                </button>
              ) : null}
            </div>
          ))}

          <button
            type="button"
            onClick={() => setLines((current) => [...current, emptyLine()])}
            className="btn-secondary w-full"
          >
            Add another medicine
          </button>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="w-full border-b border-slate-100 pb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Filing
          </legend>

          <label className="flex items-start gap-2.5 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={copyHeld}
              onChange={(event) => setCopyHeld(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            <span>
              A copy is held at the counter
              <span className="block text-xs text-slate-500">
                A flag, not a file - this system does not store scans yet.
              </span>
            </span>
          </label>

          <Field label="Notes" htmlFor="notes">
            <textarea
              id="notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={2}
              maxLength={1000}
              className="input"
            />
          </Field>
        </fieldset>

        <button type="submit" className="sr-only">
          File
        </button>
      </form>
    </SlideOver>
  );
}

/** Debounced lookup against an endpoint that returns a list of hits. */
function useSearch<T>(url: (term: string) => string, minChars = 2) {
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<T[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const value = term.trim();
    if (value.length < minChars) {
      setHits([]);
      setBusy(false);
      return;
    }

    setBusy(true);
    const timer = setTimeout(async () => {
      const result = await apiFetch<T[]>(url(value));
      setBusy(false);
      if (result.ok) setHits(result.data);
    }, 250);

    return () => clearTimeout(timer);
  }, [term, url, minChars]);

  return { term, setTerm, hits, setHits, busy };
}

function PatientSearch({ onPick }: { onPick: (customer: CustomerHit) => void }) {
  const { term, setTerm, hits, setHits, busy } = useSearch<CustomerHit>(
    useCallback((value: string) => `/api/customers?q=${encodeURIComponent(value)}`, []),
  );

  return (
    <div>
      <label htmlFor="patient-search" className="label">
        Look up an existing patient{" "}
        <span className="font-normal text-slate-400">(optional)</span>
      </label>
      <input
        id="patient-search"
        type="search"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        placeholder="Name or phone"
        autoComplete="off"
        className="input"
      />
      {busy ? <p className="mt-1 text-xs text-slate-500">Searching…</p> : null}
      {hits.length > 0 ? (
        <ul className="mt-2 max-h-44 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(hit);
                  setTerm("");
                  setHits([]);
                }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
              >
                <span className="font-medium text-slate-900">{hit.name}</span>
                {hit.phone ? (
                  <span className="tnum ml-2 text-xs text-slate-500">{hit.phone}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function MedicineSearch({
  index,
  onPick,
}: {
  index: number;
  onPick: (hit: MedicineHit) => void;
}) {
  const { term, setTerm, hits, setHits, busy } = useSearch<MedicineHit>(
    useCallback(
      (value: string) => `/api/medicines?q=${encodeURIComponent(value)}&pageSize=12`,
      [],
    ),
  );

  return (
    <div>
      <label htmlFor={`medicine-${index}`} className="label">
        Medicine
      </label>
      <input
        id={`medicine-${index}`}
        type="search"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        placeholder="Brand, generic or salt"
        autoComplete="off"
        className="input"
      />
      {busy ? <p className="mt-1 text-xs text-slate-500">Searching…</p> : null}
      {hits.length > 0 ? (
        <ul className="mt-2 max-h-52 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 bg-white">
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(hit);
                  setTerm("");
                  setHits([]);
                }}
                className={cx(
                  "w-full px-3 py-2 text-left text-sm hover:bg-slate-50",
                )}
              >
                <span className="block font-medium text-slate-900">
                  {hit.name}
                  {hit.requiresPrescription ? (
                    <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                      Rx
                    </span>
                  ) : null}
                </span>
                {hit.genericName ? (
                  <span className="block text-[11px] text-slate-500">
                    {hit.genericName}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
