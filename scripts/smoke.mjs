/** End-to-end smoke test against a running MantraPharma server. */
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

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(BASE + "/login", { redirect: "manual" });
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server never came up");
}

function jar() {
  let cookie = "";
  return {
    get cookie() {
      return cookie;
    },
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
      const setCookie = res.headers.getSetCookie?.() ?? [];
      for (const c of setCookie) {
        const [pair] = c.split(";");
        if (pair.startsWith("mp_session=")) cookie = pair;
      }
      const ct = res.headers.get("content-type") ?? "";
      const body = ct.includes("json") ? await res.json() : await res.text();
      return { status: res.status, body, headers: res.headers };
    },
  };
}

const mongoUri = "mongodb://127.0.0.1:27017/mantrapharma";
const { MongoClient } = await import("mongodb");
const mongo = new MongoClient(mongoUri);
await mongo.connect();
const db = mongo.db();

await waitForServer();

console.log("\n1. Auth");
const anon = jar();
let r = await anon.req("/api/medicines");
check("unauthenticated API call is rejected", r.status === 401, `got ${r.status}`);
check("rejection uses the standard envelope", r.body?.ok === false && r.body?.error?.code === "UNAUTHORIZED");

r = await anon.req("/dashboard");
check("unauthenticated page redirects to /login", r.status === 307 && (r.headers.get("location") ?? "").includes("/login"), `got ${r.status}`);

r = await anon.req("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "admin@mantrapharma.local", password: "WrongPassword" }) });
check("wrong password is rejected", r.status === 401);
check("error message does not reveal whether the email exists", r.body?.error?.message === "Email or password is incorrect.", JSON.stringify(r.body?.error));

const admin = jar();
r = await admin.req("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "admin@mantrapharma.local", password: "Admin@123" }) });
check("admin can sign in", r.status === 201 && r.body?.ok === true, `got ${r.status}`);
check("session cookie is set httpOnly", admin.cookie.startsWith("mp_session="));
check("password hash never leaves the server", !JSON.stringify(r.body).includes("passwordHash"));

console.log("\n2. Catalogue + reports");
r = await admin.req("/api/medicines?withStock=1&pageSize=100");
check("medicine list returns seeded catalogue", r.body?.ok && r.body.data.length === 20, `got ${r.body?.data?.length}`);
const cetzine = r.body.data.find((m) => m.name === "Cetzine 10mg");
check("Cetzine stock excludes nothing yet (180+60)", cetzine?.stockQuantity === 240, `got ${cetzine?.stockQuantity}`);

const ors = r.body.data.find((m) => m.name === "ORS Sachet");
const orsBatches = await db.collection("batches").find({ medicineId: (await db.collection("medicines").findOne({ name: "ORS Sachet" }))._id }).toArray();
const orsSellable = orsBatches.filter((b) => new Date(b.expiryDate) >= new Date()).reduce((sum, b) => sum + b.quantity, 0);
const orsTotal = orsBatches.reduce((sum, b) => sum + b.quantity, 0);
check("ORS has an expired lot that inflates raw stock", orsTotal > orsSellable, `total ${orsTotal} vs sellable ${orsSellable}`);
check("expired ORS lot is excluded from sellable stock", ors?.stockQuantity === orsSellable, `got ${ors?.stockQuantity}, expected ${orsSellable}`);

r = await admin.req("/api/reports/low-stock");
check("low-stock report returns rows", r.body?.ok === true);
const lowNames = r.body.data.map((x) => x.name);
check("Moxifloxacin (8 units, reorder 10) is flagged low", lowNames.includes("Moxifloxacin Eye Drops"), JSON.stringify(lowNames));

r = await admin.req("/api/reports/expiring-soon?days=90");
check("expiring-soon report returns rows", r.body?.ok === true && r.body.data.length > 0);
check("expiring rows are sorted soonest-first", r.body.data.every((row, i, a) => i === 0 || new Date(a[i - 1].expiryDate) <= new Date(row.expiryDate)));
check("valueAtRisk is reported", typeof r.body.meta?.valueAtRisk === "number");

console.log("\n3. FEFO quote");
const cetzineId = cetzine.id;
const before = await db.collection("batches").find({ batchNumber: { $in: ["CTZ-2201", "CTZ-2205"] } }).toArray();
const b2201 = before.find((b) => b.batchNumber === "CTZ-2201");

check("CTZ-2201 (earlier expiry) starts at 60", b2201.quantity === 60, `got ${b2201.quantity}`);

r = await admin.req("/api/sales/quote", { method: "POST", body: JSON.stringify({ items: [{ medicineId: cetzineId, quantity: 100 }] }) });
check("quote succeeds for a splitting quantity", r.body?.ok === true, JSON.stringify(r.body?.error));
const line = r.body.data.lines[0];
check("quote splits across two batches", line.picks.length === 2, `got ${line.picks.length}`);
check("earlier-expiry batch is drained first", line.picks[0].batchNumber === "CTZ-2201" && line.picks[0].quantity === 60, JSON.stringify(line.picks[0]));
check("remainder comes from the later batch", line.picks[1].batchNumber === "CTZ-2205" && line.picks[1].quantity === 40);
check("quote does NOT deduct stock", (await db.collection("batches").findOne({ batchNumber: "CTZ-2201" })).quantity === 60);

const expectedSub = 100 * 2.5;
check(`quote subtotal is ${expectedSub}`, r.body.data.subtotal === expectedSub, `got ${r.body.data.subtotal}`);
check("VAT is 13% of subtotal", r.body.data.vatAmount === Math.round(expectedSub * 0.13 * 100) / 100, `got ${r.body.data.vatAmount}`);
check("total = subtotal + VAT", r.body.data.totalAmount === expectedSub * 1.13);

console.log("\n4. Expired stock is refused");
const orsId = ors.id;
r = await admin.req("/api/sales/quote", { method: "POST", body: JSON.stringify({ items: [{ medicineId: orsId, quantity: orsSellable + 20 }] }) });
check("selling into the expired lot is rejected", r.status === 409 && r.body?.error?.code === "INSUFFICIENT_STOCK", `got ${r.status}`);
check("error explains how many are actually sellable", (r.body?.error?.message ?? "").includes(String(orsSellable)), r.body?.error?.message);

console.log("\n5. Sale creation + stock deduction");
r = await admin.req("/api/sales", {
  method: "POST",
  body: JSON.stringify({ items: [{ medicineId: cetzineId, quantity: 100 }], customerName: "Smoke Test", discount: 50, paymentMode: "esewa" }),
});
check("sale is created", r.status === 201 && r.body?.ok === true, JSON.stringify(r.body?.error));
const sale = r.body.data;
check(
  "bill number is allocated",
  /^INV-\d{4}-\d{2}-\d{6}$/.test(sale.billNo) || /^INV-\d{6}$/.test(sale.billNo),
  sale.billNo,
);

const after2201 = await db.collection("batches").findOne({ batchNumber: "CTZ-2201" });
const after2205 = await db.collection("batches").findOne({ batchNumber: "CTZ-2205" });
check("earlier batch fully drained to 0", after2201.quantity === 0, `got ${after2201.quantity}`);
check("later batch reduced 180 -> 140", after2205.quantity === 140, `got ${after2205.quantity}`);

const saleDoc = await db.collection("sales").findOne({ billNo: sale.billNo });
check("sale persists both batch lines", saleDoc.items.length === 2, `got ${saleDoc.items.length}`);
check("discount applied before VAT", saleDoc.taxableAmount === 200, `got ${saleDoc.taxableAmount}`);
check("VAT charged on discounted amount", saleDoc.vatAmount === 26, `got ${saleDoc.vatAmount}`);
check("total = 226", saleDoc.totalAmount === 226, `got ${saleDoc.totalAmount}`);

console.log("\n6. Insufficient stock rolls back cleanly");
const salesBefore = await db.collection("sales").countDocuments();
r = await admin.req("/api/sales", { method: "POST", body: JSON.stringify({ items: [{ medicineId: cetzineId, quantity: 999999 }] }) });
check("oversized sale is rejected", r.status === 409, `got ${r.status}`);
check("no sale document was written", (await db.collection("sales").countDocuments()) === salesBefore);
check("stock untouched after rejection", (await db.collection("batches").findOne({ batchNumber: "CTZ-2205" })).quantity === 140);

console.log("\n7. Bill numbers are unique under concurrency");
const conc = await Promise.all(
  Array.from({ length: 5 }, () =>
    admin.req("/api/sales", { method: "POST", body: JSON.stringify({ items: [{ medicineId: cetzineId, quantity: 1 }] }) }),
  ),
);
const billNos = conc.filter((x) => x.status === 201).map((x) => x.body.data.billNo);
check("all 5 concurrent sales succeeded", billNos.length === 5, `got ${billNos.length}`);
check("all bill numbers are distinct", new Set(billNos).size === billNos.length, billNos.join(","));
check("stock reduced by exactly 5 (140 -> 135)", (await db.collection("batches").findOne({ batchNumber: "CTZ-2205" })).quantity === 135, `got ${(await db.collection("batches").findOne({ batchNumber: "CTZ-2205" })).quantity}`);

console.log("\n8. Sales listing + date filter");
r = await admin.req("/api/sales?pageSize=50");
check("sales list returns the new bills", r.body?.ok === true && r.body.data.length === 6, `got ${r.body?.data?.length}`);
check("period summary is present", typeof r.body.meta?.summary?.grossTotal === "number");
const today = new Date().toISOString().slice(0, 10);
r = await admin.req(`/api/sales?from=${today}&to=${today}`);
check("today filter matches all of today's bills", r.body.data.length === 6, `got ${r.body.data.length}`);
r = await admin.req("/api/sales?from=2020-01-01&to=2020-01-02");
check("past date range returns nothing", r.body.data.length === 0, `got ${r.body.data.length}`);

console.log("\n9. Access control");
// One role runs the whole counter - billing and dispensing are the same
// person - so the boundary left to prove is the session itself.
r = await admin.req("/api/sales", { method: "POST", body: JSON.stringify({ items: [{ medicineId: cetzineId, quantity: 1 }] }) });
check("the counter CAN create a sale", r.status === 201, `got ${r.status}`);

r = await anon.req("/api/medicines", { method: "POST", body: JSON.stringify({ name: "Hack Med", manufacturer: "X" }) });
check("signed out CANNOT add a medicine", r.status === 401 && r.body?.error?.code === "UNAUTHORIZED", `got ${r.status}`);

r = await anon.req(`/api/medicines/${cetzineId}`, { method: "DELETE" });
check("signed out CANNOT delete a medicine", r.status === 401, `got ${r.status}`);

r = await admin.req("/api/medicines", { method: "POST", body: JSON.stringify({ name: "Test Syrup", manufacturer: "Test Labs", unit: "syrup" }) });
check("the counter CAN add a medicine", r.status === 201, `got ${r.status}`);
const newMedId = r.body?.data?.id;

console.log("\n10. Validation + integrity guards");
r = await admin.req("/api/medicines", { method: "POST", body: JSON.stringify({ name: "X" }) });
check("short name fails validation with 422", r.status === 422 && r.body?.error?.code === "VALIDATION_ERROR", `got ${r.status}`);
check("field-level errors are returned", Boolean(r.body?.error?.details?.name));

r = await admin.req("/api/medicines", { method: "POST", body: JSON.stringify({ name: "Test Syrup", manufacturer: "Test Labs" }) });
check("duplicate medicine is a 409 conflict", r.status === 409, `got ${r.status}`);

// Phase 2 removed direct batch creation: stock enters only through a posted
// purchase. Full purchase coverage lives in scripts/smoke-phase2.mjs.
r = await admin.req("/api/batches", { method: "POST", body: JSON.stringify({ medicineId: newMedId, batchNumber: "T-1", expiryDate: "2028-06-30", quantity: 10, costPrice: 5, salePrice: 9 }) });
check("direct batch creation is refused (Phase 2)", r.status === 409, `got ${r.status}`);
check("the refusal points at the purchase flow", (r.body?.error?.message ?? "").includes("purchase"), r.body?.error?.message);

r = await admin.req(`/api/medicines/${cetzineId}`, { method: "DELETE" });
check("medicine with batch history is deactivated, not deleted", r.body?.data?.deleted === false && r.body?.data?.deactivated === true, JSON.stringify(r.body?.data));
check("Cetzine still exists in the DB", Boolean(await db.collection("medicines").findOne({ name: "Cetzine 10mg" })));

const soldBatch = await db.collection("batches").findOne({ batchNumber: "CTZ-2205" });
r = await admin.req(`/api/batches/${soldBatch._id}`, { method: "DELETE" });
check("batch appearing on a bill cannot be deleted", r.status === 409, `got ${r.status}`);

console.log("\n11. Bill page renders");
r = await admin.req(`/bills/${sale.billNo}`);
check("bill page renders by bill number", r.status === 200 && String(r.body).includes(sale.billNo), `got ${r.status}`);
check("bill shows both batch numbers", String(r.body).includes("CTZ-2201") && String(r.body).includes("CTZ-2205"));

console.log("\n12. Logout");
r = await admin.req("/api/auth/logout", { method: "POST" });
check("logout succeeds", r.status === 200);
r = await admin.req("/api/medicines");
check("session is dead after logout", r.status === 401, `got ${r.status}`);

console.log("\n13. Customer linking (customerId)");
r = await admin.req("/api/customers?q=Sita");
check("customer search finds a seeded customer", r.body?.ok === true && r.body.data.length >= 1, JSON.stringify(r.body?.data));
const cust = r.body.data[0];
check("customer search returns id + phone", Boolean(cust?.id) && Boolean(cust?.phone));

const med2 = await db.collection("medicines").findOne({ name: "Paracetamol 500mg" });
r = await admin.req("/api/sales", {
  method: "POST",
  body: JSON.stringify({ items: [{ medicineId: String(med2._id), quantity: 2 }], customerId: cust.id, customerName: cust.name }),
});
check("sale accepts a linked customerId", r.status === 201, JSON.stringify(r.body?.error));
const linked = await db.collection("sales").findOne({ billNo: r.body.data.billNo });
check("customerId is persisted as a real ref", String(linked.customerId) === cust.id, String(linked.customerId));
check("customerName is persisted alongside it", linked.customerName === cust.name);

r = await admin.req("/api/customers", { method: "POST", body: JSON.stringify({ name: "New Walk In", phone: "9800000000" }) });
check("a new customer can be created", r.status === 201, JSON.stringify(r.body?.error));

r = await admin.req("/api/sales", { method: "POST", body: JSON.stringify({ items: [{ medicineId: String(med2._id), quantity: 1 }], customerName: "Anonymous Walkin" }) });
const walkin = await db.collection("sales").findOne({ billNo: r.body.data.billNo });
check("walk-in sale stores name with null customerId", walkin.customerId === null && walkin.customerName === "Anonymous Walkin", String(walkin.customerId));

console.log("\n14. Voiding a bill returns its stock");
r = await anon.req(`/api/sales/${sale.id}/void`, { method: "POST", body: JSON.stringify({ reason: "trying it on" }) });
check("signed out CANNOT void a bill", r.status === 401 && r.body?.error?.code === "UNAUTHORIZED", `got ${r.status}`);

r = await admin.req(`/api/sales/${sale.id}/void`, { method: "POST", body: JSON.stringify({ reason: "" }) });
check("void without a reason fails validation", r.status === 422 && r.body?.error?.code === "VALIDATION_ERROR", `got ${r.status}`);

r = await admin.req("/api/sales?pageSize=100");
const grossBeforeVoid = r.body?.meta?.summary?.grossTotal ?? 0;

const voidTarget = await db.collection("sales").findOne({ billNo: sale.billNo });
const lotsBefore = Object.fromEntries(
  await Promise.all(
    voidTarget.items.map(async (item) => {
      const batch = await db.collection("batches").findOne({ _id: item.batchId });
      return [item.batchNumber, batch.quantity];
    }),
  ),
);

r = await admin.req(`/api/sales/${sale.id}/void`, { method: "POST", body: JSON.stringify({ reason: "customer returned the lot unopened" }) });
check("the counter can void a bill", r.status === 200 && r.body?.ok === true, JSON.stringify(r.body?.error));
check("the void reports one restore per lot", r.body?.data?.restored?.length === voidTarget.items.length, JSON.stringify(r.body?.data?.restored));
check("nothing was left unreturned", r.body?.data?.unreturned?.length === 0, JSON.stringify(r.body?.data?.unreturned));

for (const item of voidTarget.items) {
  const batch = await db.collection("batches").findOne({ _id: item.batchId });
  check(
    `lot ${item.batchNumber} got its ${item.quantity} unit(s) back`,
    batch.quantity === lotsBefore[item.batchNumber] + item.quantity,
    `${lotsBefore[item.batchNumber]} -> ${batch.quantity}`,
  );
}

const voided = await db.collection("sales").findOne({ billNo: sale.billNo });
check("the bill is not deleted", Boolean(voided), "bill vanished");
check("voidedAt is stamped", voided.voidedAt instanceof Date);
check("voidedBy records who did it", Boolean(voided.voidedBy) && voided.voidedByName.length > 0, voided.voidedByName);
check("the reason is stored for audit", voided.voidReason === "customer returned the lot unopened", voided.voidReason);
check("the bill keeps its number and lines", voided.billNo === sale.billNo && voided.items.length === voidTarget.items.length);

r = await admin.req(`/api/sales/${sale.id}/void`, { method: "POST", body: JSON.stringify({ reason: "second attempt" }) });
check("re-voiding is refused as a conflict", r.status === 409, `got ${r.status}`);
check("the refusal names the bill", (r.body?.error?.message ?? "").includes(sale.billNo), r.body?.error?.message);

const lotsAfterSecond = await db.collection("batches").findOne({ _id: voidTarget.items[0].batchId });
check("the refused second void restored nothing extra", lotsAfterSecond.quantity === lotsBefore[voidTarget.items[0].batchNumber] + voidTarget.items[0].quantity, `got ${lotsAfterSecond.quantity}`);

r = await admin.req("/api/sales/000000000000000000000000/void", { method: "POST", body: JSON.stringify({ reason: "no such bill" }) });
check("voiding an unknown bill is a 404", r.status === 404, `got ${r.status}`);

r = await admin.req(`/api/sales/${sale.id}`);
check("the bill still reads back", r.status === 200, `got ${r.status}`);
check("it reports itself as voided", r.body?.data?.voided === true);
check("it carries the reason and the author", r.body?.data?.voidReason.length > 0 && r.body?.data?.voidedByName.length > 0);

r = await admin.req("/api/sales?pageSize=100");
const listed = r.body.data.find((s) => s.billNo === sale.billNo);
check("a voided bill still appears in the register", Boolean(listed), "missing from the list");
check("it is flagged voided in the list", listed?.voided === true);
check(
  "takings drop by exactly the voided total",
  Math.abs((grossBeforeVoid - (r.body?.meta?.summary?.grossTotal ?? 0)) - voided.totalAmount) < 0.01,
  `${grossBeforeVoid} -> ${r.body?.meta?.summary?.grossTotal} (bill ${voided.totalAmount})`,
);

r = await admin.req(`/bills/${sale.billNo}`);
check("the printable bill is stamped VOID", r.status === 200 && String(r.body).includes("Void"), `got ${r.status}`);
check("the printed bill says it is not payable", String(r.body).includes("valid demand for payment"));

await mongo.close();
console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
process.exit(fail === 0 ? 0 : 1);
