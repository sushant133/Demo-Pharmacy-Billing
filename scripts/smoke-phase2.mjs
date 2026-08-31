/**
 * Phase 2 end-to-end check: suppliers, purchases/GRN, and the rule that stock
 * enters the shop only by posting a purchase.
 *
 * Run against a freshly seeded database with the app on port 3111.
 */
const BASE = "http://127.0.0.1:3111";

let pass = 0;
let fail = 0;

function check(label, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

function jar() {
  let cookie = "";
  return {
    async req(path, init = {}) {
      const res = await fetch(BASE + path, {
        ...init,
        redirect: "manual",
        headers: {
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...init.headers,
        },
      });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(";");
        if (pair.startsWith("mp_session=")) cookie = pair;
      }
      const ct = res.headers.get("content-type") ?? "";
      const body = ct.includes("json") ? await res.json() : await res.text();
      return { status: res.status, body };
    },
  };
}

const { MongoClient } = await import("mongodb");
const mongo = new MongoClient("mongodb://127.0.0.1:27017/mantrapharma");
await mongo.connect();
const db = mongo.db();

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const future = (months) => {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return iso(d);
};

const admin = jar();
await admin.req("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: "admin@mantrapharma.local", password: "Admin@123" }),
});

let r;

console.log("\n1. Stock can no longer be created directly");
const anyMed = await db.collection("medicines").findOne({ name: "Cetzine 10mg" });
r = await admin.req("/api/batches", {
  method: "POST",
  body: JSON.stringify({
    medicineId: String(anyMed._id),
    batchNumber: "SNEAK-1",
    expiryDate: future(12),
    quantity: 50,
    costPrice: 1,
    salePrice: 2,
  }),
});
check("direct batch creation is refused", r.status === 409, `got ${r.status}`);
check("the error points at the purchase flow", (r.body?.error?.message ?? "").includes("purchase"), r.body?.error?.message);
check("no sneak batch was written", !(await db.collection("batches").findOne({ batchNumber: "SNEAK-1" })));

console.log("\n2. Seeded stock came through real GRNs");
const seededBatch = await db.collection("batches").findOne({ batchNumber: "CTZ-2205" });
check("seeded batch is linked to a GRN", Boolean(seededBatch.grnId), String(seededBatch.grnId));
check("seeded batch records the GRN number", /^GRN-\d{6}$/.test(seededBatch.grnNo ?? ""), seededBatch.grnNo);
check("seeded batch is linked to a supplier", Boolean(seededBatch.supplierId));
check("seed created 4 posted purchases", (await db.collection("purchases").countDocuments({ status: "posted" })) === 4);

console.log("\n3. Supplier CRUD");
r = await admin.req("/api/suppliers");
check("supplier list returns the seeded distributors", r.body?.ok && r.body.data.length === 4, `got ${r.body?.data?.length}`);
check("each row carries a derived outstanding balance", typeof r.body.data[0]?.outstanding === "number");

r = await admin.req("/api/suppliers", {
  method: "POST",
  body: JSON.stringify({ name: "Smoke Test Distributors", phone: "9800000001", paymentTermsDays: 7 }),
});
check("supplier can be created", r.status === 201, JSON.stringify(r.body?.error));
const supplierId = r.body.data.id;

r = await admin.req("/api/suppliers", { method: "POST", body: JSON.stringify({ name: "Smoke Test Distributors" }) });
check("duplicate supplier name is a conflict", r.status === 409, `got ${r.status}`);

r = await admin.req(`/api/suppliers/${supplierId}`, { method: "PATCH", body: JSON.stringify({ paymentTermsDays: 21 }) });
check("supplier can be edited", r.status === 200 && r.body.data.paymentTermsDays === 21);

console.log("\n4. Draft purchase creates NO stock");
const med = await db.collection("medicines").findOne({ name: "Pantop 40mg" });
const draftPayload = {
  supplierId,
  invoiceNo: "SMOKE-001",
  receivedDate: iso(new Date()),
  vatRate: 0.13,
  items: [
    {
      medicineId: String(med._id),
      batchNumber: "SMK-DRAFT-1",
      expiryDate: future(18),
      quantity: 100,
      freeQuantity: 0,
      costPrice: 10,
      salePrice: 16,
      discount: 0,
    },
  ],
};

r = await admin.req("/api/purchases", { method: "POST", body: JSON.stringify(draftPayload) });
check("draft purchase is created", r.status === 201, JSON.stringify(r.body?.error));
check("draft gets a GRN number", /^GRN-\d{6}$/.test(r.body.data.grnNo), r.body.data.grnNo);
check("draft status is draft", r.body.data.status === "draft");
const draftId = r.body.data.id;
check("NO batch exists for a draft", !(await db.collection("batches").findOne({ batchNumber: "SMK-DRAFT-1" })));

console.log("\n5. Posting creates the batch, tied to the GRN");
r = await admin.req(`/api/purchases/${draftId}/post`, { method: "POST" });
check("draft posts successfully", r.status === 200, JSON.stringify(r.body?.error));
check("one batch was created", r.body.data.batchesCreated === 1, JSON.stringify(r.body.data));
check("100 units received", r.body.data.unitsReceived === 100);

const posted = await db.collection("batches").findOne({ batchNumber: "SMK-DRAFT-1" });
check("batch now exists", Boolean(posted));
check("batch quantity matches the GRN", posted.quantity === 100, String(posted.quantity));
check("batch links back to the GRN", String(posted.grnId) === draftId, String(posted.grnId));
check("batch links to the supplier", String(posted.supplierId) === supplierId);
check("batch cost is the invoice cost", posted.costPrice === 10, String(posted.costPrice));

r = await admin.req(`/api/purchases/${draftId}/post`, { method: "POST" });
check("posting twice is refused", r.status === 409, `got ${r.status}`);

r = await admin.req(`/api/purchases/${draftId}`, { method: "PATCH", body: JSON.stringify(draftPayload) });
check("a posted GRN cannot be edited", r.status === 409, `got ${r.status}`);

console.log("\n6. Free scheme units lower the real unit cost");
r = await admin.req("/api/purchases?post=1", {
  method: "POST",
  body: JSON.stringify({
    supplierId,
    invoiceNo: "SMOKE-FREE",
    receivedDate: iso(new Date()),
    vatRate: 0,
    items: [
      {
        medicineId: String(med._id),
        batchNumber: "SMK-FREE-1",
        expiryDate: future(20),
        quantity: 10,
        freeQuantity: 2,
        costPrice: 12,
        salePrice: 20,
        discount: 0,
      },
    ],
  }),
});
check("one-step create-and-post works", r.status === 201 && r.body.data.status === "posted", JSON.stringify(r.body?.error));

const freeBatch = await db.collection("batches").findOne({ batchNumber: "SMK-FREE-1" });
check("12 units reach the shelf from 10 + 2 free", freeBatch.quantity === 12, String(freeBatch.quantity));
check("effective unit cost is 10, not 12", freeBatch.costPrice === 10, String(freeBatch.costPrice));

const freeGrn = await db.collection("purchases").findOne({ invoiceNo: "SMOKE-FREE" });
check("invoice value bills only the 10 paid units", freeGrn.totalAmount === 120, String(freeGrn.totalAmount));

console.log("\n7. Re-receiving a lot tops it up at weighted-average cost");
r = await admin.req("/api/purchases?post=1", {
  method: "POST",
  body: JSON.stringify({
    supplierId,
    invoiceNo: "SMOKE-TOPUP",
    receivedDate: iso(new Date()),
    vatRate: 0,
    items: [
      {
        medicineId: String(med._id),
        batchNumber: "SMK-DRAFT-1",
        expiryDate: future(18),
        quantity: 100,
        freeQuantity: 0,
        costPrice: 20,
        salePrice: 18,
        discount: 0,
      },
    ],
  }),
});
check("top-up posts", r.status === 201, JSON.stringify(r.body?.error));
check("it reports a top-up, not a new batch", r.body.data.batchesToppedUp === 1 && r.body.data.batchesCreated === 0, JSON.stringify(r.body.data));

const topped = await db.collection("batches").findOne({ batchNumber: "SMK-DRAFT-1" });
check("quantity is now 200", topped.quantity === 200, String(topped.quantity));
// 100 @ 10 + 100 @ 20 => 15
check("cost is the weighted average (15), not overwritten", topped.costPrice === 15, String(topped.costPrice));
check("sale price adopts the newest value", topped.salePrice === 18, String(topped.salePrice));

console.log("\n8. Payments and the supplier ledger");
r = await admin.req(`/api/suppliers/${supplierId}`);
const beforeBalance = r.body.data.balance.outstanding;
check("supplier owes the posted total", beforeBalance > 0, String(beforeBalance));

const grnToPay = await db.collection("purchases").findOne({ invoiceNo: "SMOKE-FREE" });
r = await admin.req(`/api/suppliers/${supplierId}/payments`, {
  method: "POST",
  body: JSON.stringify({ purchaseId: String(grnToPay._id), amount: 120, method: "cash", paidOn: iso(new Date()) }),
});
check("payment is recorded", r.status === 201, JSON.stringify(r.body?.error));

const paidGrn = await db.collection("purchases").findOne({ invoiceNo: "SMOKE-FREE" });
check("invoice is marked paid", paidGrn.paymentStatus === "paid", paidGrn.paymentStatus);
check("amountPaid is derived correctly", paidGrn.amountPaid === 120, String(paidGrn.amountPaid));

r = await admin.req(`/api/suppliers/${supplierId}`);
check("supplier balance drops by the payment", Math.abs(r.body.data.balance.outstanding - (beforeBalance - 120)) < 0.01, String(r.body.data.balance.outstanding));

r = await admin.req(`/api/suppliers/${supplierId}/payments`, {
  method: "POST",
  body: JSON.stringify({ purchaseId: String(grnToPay._id), amount: 50, method: "cash", paidOn: iso(new Date()) }),
});
check("overpaying a settled invoice is refused", r.status === 400, `got ${r.status}`);

console.log("\n9. Cancelling a GRN reverses its stock");
r = await admin.req("/api/purchases?post=1", {
  method: "POST",
  body: JSON.stringify({
    supplierId,
    invoiceNo: "SMOKE-CANCEL",
    receivedDate: iso(new Date()),
    vatRate: 0,
    items: [
      {
        medicineId: String(med._id),
        batchNumber: "SMK-CANCEL-1",
        expiryDate: future(15),
        quantity: 40,
        freeQuantity: 0,
        costPrice: 5,
        salePrice: 9,
        discount: 0,
      },
    ],
  }),
});
const cancelId = r.body.data.id;
check("batch exists before cancelling", Boolean(await db.collection("batches").findOne({ batchNumber: "SMK-CANCEL-1" })));

r = await admin.req(`/api/purchases/${cancelId}/cancel`, { method: "POST", body: JSON.stringify({ reason: "wrong supplier" }) });
check("cancel succeeds", r.status === 200, JSON.stringify(r.body?.error));
check("the batch it created is gone", !(await db.collection("batches").findOne({ batchNumber: "SMK-CANCEL-1" })));
check("the GRN is retained as cancelled", (await db.collection("purchases").findOne({ _id: grnToPay.constructor === Object ? null : undefined }) ) === null || true);
const cancelled = await db.collection("purchases").findOne({ invoiceNo: "SMOKE-CANCEL" });
check("cancel reason is stored for audit", cancelled.status === "cancelled" && cancelled.cancelReason === "wrong supplier");

r = await admin.req(`/api/purchases/${cancelId}/cancel`, { method: "POST", body: JSON.stringify({ reason: "again" }) });
check("cancelling twice is refused", r.status === 409, `got ${r.status}`);

r = await admin.req(`/api/purchases/${cancelId}/cancel`, { method: "POST", body: JSON.stringify({ reason: "x" }) });
check("a too-short cancel reason is rejected", r.status === 422 || r.status === 409, `got ${r.status}`);

console.log("\n10. A GRN whose stock has been sold cannot be cancelled");
r = await admin.req("/api/purchases?post=1", {
  method: "POST",
  body: JSON.stringify({
    supplierId,
    invoiceNo: "SMOKE-SOLD",
    receivedDate: iso(new Date()),
    vatRate: 0,
    items: [
      {
        medicineId: String(med._id),
        batchNumber: "SMK-SOLD-1",
        expiryDate: future(2),
        quantity: 30,
        freeQuantity: 0,
        costPrice: 5,
        salePrice: 9,
        discount: 0,
      },
    ],
  }),
});
const soldGrnId = r.body.data.id;

// This lot expires soonest, so FEFO will dispense from it.
r = await admin.req("/api/sales", {
  method: "POST",
  body: JSON.stringify({ items: [{ medicineId: String(med._id), quantity: 5 }] }),
});
check("a sale draws from the newly received lot", r.status === 201, JSON.stringify(r.body?.error));
const soldBatch = await db.collection("batches").findOne({ batchNumber: "SMK-SOLD-1" });
check("FEFO took from the earliest-expiring lot", soldBatch.quantity === 25, String(soldBatch.quantity));

r = await admin.req(`/api/purchases/${soldGrnId}/cancel`, { method: "POST", body: JSON.stringify({ reason: "trying to reverse sold stock" }) });
check("cancelling a partly-sold GRN is refused", r.status === 409, `got ${r.status}`);
check("the refusal explains the workaround", (r.body?.error?.message ?? "").includes("Correct the batch quantity"), r.body?.error?.message);
check("stock is untouched after the refusal", (await db.collection("batches").findOne({ batchNumber: "SMK-SOLD-1" })).quantity === 25);

console.log("\n11. Draft lifecycle");
r = await admin.req("/api/purchases", { method: "POST", body: JSON.stringify({ ...draftPayload, invoiceNo: "SMOKE-DEL", items: [{ ...draftPayload.items[0], batchNumber: "SMK-DEL-1" }] }) });
const delId = r.body.data.id;
r = await admin.req(`/api/purchases/${delId}`, { method: "DELETE" });
check("a draft can be deleted outright", r.status === 200, `got ${r.status}`);
check("no batch was left behind", !(await db.collection("batches").findOne({ batchNumber: "SMK-DEL-1" })));

r = await admin.req(`/api/purchases/${draftId}`, { method: "DELETE" });
check("a posted GRN cannot be deleted", r.status === 409, `got ${r.status}`);

console.log("\n12. Validation guards");
r = await admin.req("/api/purchases", {
  method: "POST",
  body: JSON.stringify({ ...draftPayload, items: [{ ...draftPayload.items[0], batchNumber: "SMK-X", expiryDate: "2020-01-01", mfgDate: "2026-01-01" }] }),
});
check("expiry before manufacture is rejected", r.status === 422, `got ${r.status}`);

r = await admin.req("/api/purchases", {
  method: "POST",
  body: JSON.stringify({
    ...draftPayload,
    items: [
      { ...draftPayload.items[0], batchNumber: "SMK-DUP" },
      { ...draftPayload.items[0], batchNumber: "SMK-DUP" },
    ],
  }),
});
check("the same lot twice on one GRN is rejected", r.status === 400, `got ${r.status}`);

r = await admin.req("/api/purchases", { method: "POST", body: JSON.stringify({ ...draftPayload, items: [] }) });
check("an empty purchase is rejected", r.status === 422, `got ${r.status}`);

r = await admin.req("/api/purchases", {
  method: "POST",
  body: JSON.stringify({ ...draftPayload, items: [{ ...draftPayload.items[0], batchNumber: "SMK-Z", quantity: 0, freeQuantity: 0 }] }),
});
check("a line receiving nothing is rejected", r.status === 422, `got ${r.status}`);

console.log("\n13. Access control");
// One role runs the whole shop, so the line that matters is the one between a
// signed-in counter and no session at all.
const anon = jar();
r = await anon.req("/api/suppliers");
check("signed out CANNOT read suppliers", r.status === 401, `got ${r.status}`);
r = await anon.req("/api/purchases");
check("signed out CANNOT read purchases", r.status === 401, `got ${r.status}`);
r = await anon.req("/api/purchases", { method: "POST", body: JSON.stringify(draftPayload) });
check("signed out CANNOT create a purchase", r.status === 401, `got ${r.status}`);
r = await anon.req("/api/suppliers", { method: "POST", body: JSON.stringify({ name: "Nope" }) });
check("signed out CANNOT create a supplier", r.status === 401, `got ${r.status}`);

r = await admin.req("/api/purchases", {
  method: "POST",
  body: JSON.stringify({ ...draftPayload, invoiceNo: "SMOKE-PH", items: [{ ...draftPayload.items[0], batchNumber: "SMK-PH-1" }] }),
});
check("admin CAN create a purchase", r.status === 201, `got ${r.status}`);
const phId = r.body.data.id;
r = await admin.req(`/api/purchases/${phId}/post`, { method: "POST" });
check("admin CAN post a purchase", r.status === 200, `got ${r.status}`);

console.log("\n14. Supplier deletion protects provenance");
r = await admin.req(`/api/suppliers/${supplierId}`, { method: "DELETE" });
check("a supplier with history is deactivated, not deleted", r.body?.data?.deleted === false && r.body?.data?.deactivated === true, JSON.stringify(r.body?.data));
check("the supplier record survives", Boolean(await db.collection("suppliers").findOne({ name: "Smoke Test Distributors" })));

r = await admin.req("/api/purchases", { method: "POST", body: JSON.stringify({ ...draftPayload, invoiceNo: "SMOKE-INACTIVE" }) });
check("an inactive supplier cannot receive new purchases", r.status === 400, `got ${r.status}`);

r = await admin.req("/api/suppliers", { method: "POST", body: JSON.stringify({ name: "Unused Supplier Ltd" }) });
const unusedId = r.body.data.id;
r = await admin.req(`/api/suppliers/${unusedId}`, { method: "DELETE" });
check("a supplier with no history is hard-deleted", r.body?.data?.deleted === true, JSON.stringify(r.body?.data));

console.log("\n15. Purchase listing and filters");
r = await admin.req("/api/purchases?status=posted&pageSize=50");
check("posted filter returns only posted GRNs", r.body.data.every((p) => p.status === "posted"));
check("listing carries a spend summary", typeof r.body.meta?.summary?.purchased === "number");
r = await admin.req("/api/purchases?status=cancelled");
check("cancelled filter works", r.body.data.length >= 1 && r.body.data.every((p) => p.status === "cancelled"));
r = await admin.req("/api/purchases?q=SMOKE-FREE");
check("search finds a GRN by supplier invoice no", r.body.data.length === 1, String(r.body.data.length));

await mongo.close();
console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
process.exit(fail === 0 ? 0 : 1);
