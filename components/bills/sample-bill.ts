import type { BillDocumentProps } from "@/components/bills/BillDocument";

/**
 * A made-up bill, used to show what a template prints.
 *
 * Superadmin has to choose a layout for a shop whose real bills they cannot
 * see - reading a tenant's records means a backup file or a recorded
 * impersonation, and neither is a reasonable price for "will this fit the
 * paper?". So the previews run on invented figures.
 *
 * Deliberately awkward figures: a long medicine name that has to wrap, a
 * short one that must not, a discount, a part payment leaving a balance, and
 * enough lines to show where a sheet template starts a second page. A preview
 * built from one tidy row proves nothing.
 */
export function sampleBill(overrides: Partial<BillDocumentProps> = {}): BillDocumentProps {
  return {
    templateId: "thermal-80",
    kicker: "कर बीजक / TAX INVOICE",
    issuer: {
      name: "Sample Pharmacy",
      legalName: "Sample Pharmacy Pvt. Ltd.",
      address: "Putalisadak, Kathmandu",
      phone: "01-4567890",
      email: "counter@sample.com.np",
      pan: "301234567",
      vat: "301234567",
      licence: "DDA/1234/080",
    },
    copyLabel: "ORIGINAL",
    meta: [
      { label: "Bill no", value: "INV-2082-83-000412" },
      { label: "FY", value: "2082/83" },
      { label: "Date (BS)", value: "2082-06-05 (05 Ashwin 2082)" },
      { label: "Date (AD)", value: "21 Sep 2025, 18:42" },
      { label: "Payment", value: "Cash" },
    ],
    party: [
      { label: "Buyer", value: "Sita Kumari Shrestha" },
      { label: "Buyer PAN", value: "609876543" },
      { label: "", value: "Bagbazar, Kathmandu" },
      { label: "", value: "Tel: 9801234567" },
    ],
    itemsHeading: "Item",
    items: [
      {
        name: "Amoxycillin + Clavulanic Acid 625mg tablet",
        batch: "AMX2210",
        expiry: "Aug 2027",
        qty: "10 tab",
        rate: "28.00",
        amount: "280.00",
      },
      {
        name: "Paracetamol 500mg",
        batch: "PCM0455",
        expiry: "Mar 2028",
        qty: "20 tab",
        rate: "2.50",
        amount: "50.00",
      },
      {
        name: "Ambrolite-D Syrup 100ml",
        batch: "ABD7781",
        expiry: "Nov 2026",
        qty: "1 bottle",
        rate: "165.00",
        amount: "165.00",
      },
      {
        name: "Ceftriaxone 1g Injection",
        batch: "CTX1190",
        expiry: "Jun 2027",
        qty: "2 vial",
        rate: "96.00",
        amount: "192.00",
      },
      {
        name: "Salbutamol Inhaler 100mcg",
        batch: "SLB3320",
        expiry: "Feb 2027",
        qty: "1 unit",
        rate: "425.00",
        amount: "425.00",
      },
    ],
    totals: [
      { label: "Subtotal", value: "1,112.00" },
      { label: "Discount (5%)", value: "− 55.60" },
      { label: "Taxable", value: "1,056.40" },
      { label: "VAT 13%", value: "137.33" },
      { label: "Grand total", value: "Rs 1,193.73", grand: true },
      { label: "Received", value: "1,000.00" },
      { label: "Balance due", value: "193.73" },
    ],
    words: "One thousand one hundred ninety three rupees and seventy three paisa only.",
    footLine: "Cashier: Ramesh Thapa · Main counter",
    signatureLabel: "Authorised signatory",
    tiny: [
      "Goods once sold are not returnable except as required by law. Keep this tax invoice for your records.",
      "Thank you.",
    ],
    ...overrides,
  };
}
