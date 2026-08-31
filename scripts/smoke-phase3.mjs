/**
 * Phase 3 end-to-end check: COGS capture, alert grading, analytics and export.
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
      // CSV must stay bytes so the BOM can be asserted; HTML/plain stay text.
      const body = ct.includes("json")
        ? await res.json()
        : ct.includes("csv") || ct.includes("pdf") || ct.includes("spreadsheet")
          ? Buffer.from(await res.arrayBuffer())
          : await res.text();
      return { status: res.status, body, headers: res.headers };
    },
  };
}

const { MongoClient } = await import("mongodb");
const mongo = new MongoClient("mongodb://127.0.0.1:27017/mantrapharma");
await mongo.connect();
const db = mongo.db();

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const today = iso(new Date());
const longAgo = "2020-01-01";

const admin = jar();
await admin.req("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: "admin@mantrapharma.local", password: "Admin@123" }),
});

let r;

console.log("\n1. Cost of goods is captured on every sale line");
const seededSale = await db.collection("sales").findOne({});
check("seeded sales exist", Boolean(seededSale));
check("sale records a totalCost", seededSale.totalCost > 0, String(seededSale.totalCost));
check(
  "every line carries a unit cost",
  seededSale.items.every((i) => i.unitCost > 0),
  JSON.stringify(seededSale.items.map((i) => i.unitCost)),
);
check(
  "lineCost equals quantity x unitCost",
  seededSale.items.every(
    (i) => Math.abs(i.lineCost - i.quantity * i.unitCost) < 0.011,
  ),
);
const lineSum =
  Math.round(seededSale.items.reduce((s, i) => s + i.lineCost, 0) * 100) / 100;
check("totalCost equals the sum of lines", Math.abs(lineSum - seededSale.totalCost) < 0.011,
  `${lineSum} vs ${seededSale.totalCost}`);
check("cost is below revenue (a sane margin)", seededSale.totalCost < seededSale.taxableAmount);

console.log("\n2. Cost survives a weighted-average top-up (the whole point)");
// Sell from a lot, then re-receive the same lot at a very different price.
const med = await db.collection("medicines").findOne({ name: "Metformin 500mg" });
const supplier = await db.collection("suppliers").findOne({});
const before = await db.collection("batches").findOne({ batchNumber: "MET-5540" });

r = await admin.req("/api/sales", {
  method: "POST",
  body: JSON.stringify({ items: [{ medicineId: String(med._id), quantity: 4 }] }),
});
check("a sale is created", r.status === 201, JSON.stringify(r.body?.error));
const soldBill = r.body.data.billNo;
const soldDoc = await db.collection("sales").findOne({ billNo: soldBill });
const costAtSale = soldDoc.items[0].unitCost;
check("the sale captured the batch's cost at that moment",
  Math.abs(costAtSale - before.costPrice) < 0.011, `${costAtSale} vs ${before.costPrice}`);

r = await admin.req("/api/purchases?post=1", {
  method: "POST",
  body: JSON.stringify({
    supplierId: String(supplier._id),
    invoiceNo: "P3-TOPUP",
    receivedDate: today,
    vatRate: 0,
    items: [{
      medicineId: String(med._id),
      batchNumber: "MET-5540",
      expiryDate: "2028-06-30",
      quantity: 1000, freeQuantity: 0,
      costPrice: 50, salePrice: 60, discount: 0,
    }],
  }),
});
check("a top-up at a much higher cost posts", r.status === 201, JSON.stringify(r.body?.error));

const after = await db.collection("batches").findOne({ batchNumber: "MET-5540" });
// Assert the weighted-average property itself rather than a magic multiple,
// so the check holds whatever the lot's starting cost happened to be.
check("the batch cost moved toward the new, higher price",
  after.costPrice > before.costPrice && after.costPrice < 50,
  `${before.costPrice} -> ${after.costPrice} (incoming 50)`);

const soldAfter = await db.collection("sales").findOne({ billNo: soldBill });
check("the earlier sale's recorded cost did NOT change",
  Math.abs(soldAfter.items[0].unitCost - costAtSale) < 0.001,
  `${costAtSale} -> ${soldAfter.items[0].unitCost}`);
check("its totalCost did not change either",
  Math.abs(soldAfter.totalCost - soldDoc.totalCost) < 0.001);

console.log("\n3. Analytics");
r = await admin.req(`/api/reports/analytics?from=${longAgo}&to=${today}`);
check("analytics responds", r.status === 200, `got ${r.status}`);
const a = r.body.data;
check("revenue excludes VAT", a.summary.revenue > 0 && a.summary.revenue < a.summary.collected,
  `${a.summary.revenue} vs collected ${a.summary.collected}`);
check("gross profit = revenue - cost",
  Math.abs(a.summary.grossProfit - (a.summary.revenue - a.summary.cost)) < 0.011);
check("margin is a sane percentage",
  a.summary.marginPercent > 0 && a.summary.marginPercent < 100, String(a.summary.marginPercent));
check("a time series comes back", Array.isArray(a.series) && a.series.length > 0);
check("series buckets have no gaps (zeros are filled)",
  a.series.every((p) => typeof p.revenue === "number"));
check("series profit is consistent per bucket",
  a.series.every((p) => Math.abs(p.profit - (p.revenue - p.cost)) < 0.011));
check("top medicines are ranked by profit descending",
  a.topMedicines.every((m, i, arr) => i === 0 || arr[i - 1].profit >= m.profit));
check("payment mix shares add to ~100%",
  Math.abs(a.paymentMix.reduce((s, p) => s + p.percent, 0) - 100) < 0.5);

r = await admin.req(`/api/reports/analytics?from=2019-01-01&to=2019-12-31`);
check("an empty range returns zeros rather than failing",
  r.status === 200 && r.body.data.summary.revenue === 0, `got ${r.status}`);

console.log("\n4. Graded alerts");
r = await admin.req("/api/reports/alerts?kind=expiry");
check("expiry alerts respond", r.status === 200);
check("rows are graded with a severity",
  r.body.data.every((row) => ["expired","critical","warning","watch","ok"].includes(row.severity)));
check("severity counts are returned", typeof r.body.meta.counts.expired === "number");
// Rows must come back ordered worst-first, so the top of the list is always
// what needs acting on today.
const RANK = ["expired", "critical", "warning", "watch", "ok"];
check("rows are ordered worst-severity first",
  r.body.data.every((row, i, arr) =>
    i === 0 || RANK.indexOf(arr[i - 1].severity) <= RANK.indexOf(row.severity)),
  r.body.data.map((row) => row.severity).join(","));
check("the expired ORS lot is graded expired",
  r.body.data.some((row) => row.medicineName === "ORS Sachet" && row.severity === "expired"));
check("rows carry the sales rate that justifies the grade",
  r.body.data.every((row) => typeof row.salesRate === "number"));
check("value at risk is reported and bounded by stock value",
  r.body.data.every((row) => row.valueAtRisk <= row.stockValue + 0.011));

r = await admin.req("/api/reports/alerts?kind=expiry&severity=expired");
check("filtering by severity narrows the list",
  r.body.data.every((row) => row.severity === "expired"));

r = await admin.req("/api/reports/alerts?kind=stock");
check("stock alerts respond", r.status === 200);
check("each row carries an assessment with a basis",
  r.body.data.every((row) => ["days-of-cover","reorder-level"].includes(row.assessment.basis)));
check("days-of-cover rows have a sales rate",
  r.body.data.filter((row) => row.assessment.basis === "days-of-cover")
    .every((row) => row.salesRate > 0));
check("suggested order quantity is never negative",
  r.body.data.every((row) => row.assessment.suggestedOrderQuantity >= 0));

r = await admin.req("/api/reports/alerts?kind=dead");
check("dead-stock view responds", r.status === 200);
check("dead rows all hold stock", r.body.data.every((row) => row.stockQuantity > 0));

console.log("\n5. Export - every report, every format");
const reports = ["sales-register","sales-detail","profit-by-medicine","stock-valuation",
                 "expiry","reorder","purchase-register","payables"];
for (const report of reports) {
  r = await admin.req(`/api/export?report=${report}&format=xlsx&from=${longAgo}&to=${today}`);
  const ok = r.status === 200 && Buffer.isBuffer(r.body) && r.body.subarray(0,2).toString() === "PK";
  check(`${report}: Excel is a valid workbook`, ok, `status ${r.status}`);
}

r = await admin.req(`/api/export?report=sales-register&format=pdf&from=${longAgo}&to=${today}`);
check("PDF has a valid header", r.body.subarray(0,5).toString() === "%PDF-");
check("PDF is served as a download",
  (r.headers.get("content-disposition") ?? "").startsWith("attachment;"));
check("PDF filename is stamped and slugged",
  /filename="sales-register-\d{4}-\d{2}-\d{2}\.pdf"/.test(r.headers.get("content-disposition") ?? ""),
  r.headers.get("content-disposition"));

r = await admin.req(`/api/export?report=sales-register&format=csv&from=${longAgo}&to=${today}`);
check("CSV starts with a UTF-8 BOM", r.body[0] === 0xef && r.body[1] === 0xbb && r.body[2] === 0xbf);
const csv = r.body.toString("utf8");
check("CSV contains the header row", csv.includes("Bill no,Date,Customer"));
check("CSV has a totals row", csv.includes("\r\nTotal,"));
check("exports are not cacheable", (r.headers.get("cache-control") ?? "").includes("no-store"));

r = await admin.req(`/api/export?report=nonsense&format=csv`);
check("an unknown report is rejected", r.status === 400, `got ${r.status}`);
r = await admin.req(`/api/export?report=sales-register&format=exe`);
check("an unknown format is rejected", r.status === 422, `got ${r.status}`);
r = await admin.req(`/api/export?report=sales-register&format=csv&from=${today}&to=${longAgo}`);
check("an inverted date range is rejected", r.status === 400, `got ${r.status}`);

console.log("\n6. Export numbers agree with the dashboard");
r = await admin.req(`/api/reports/analytics?from=${longAgo}&to=${today}`);
const apiRevenue = r.body.data.summary.revenue;
r = await admin.req(`/api/export?report=sales-register&format=csv&from=${longAgo}&to=${today}`);
const revenueLine = r.body.toString("utf8").split("\r\n").find((l) => l.startsWith("Revenue (excl. VAT)"));
check("the export's revenue matches the analytics API",
  revenueLine?.includes(apiRevenue.toFixed(2)), `${revenueLine} vs ${apiRevenue}`);

console.log("\n7. Financial data needs a session");
// One role sees everything, so the line worth proving is the one between a
// signed-in counter and no session at all.
const anon = jar();

r = await anon.req("/api/reports/alerts?kind=expiry");
check("signed out CANNOT read alerts", r.status === 401, `got ${r.status}`);
r = await anon.req(`/api/reports/analytics?from=${longAgo}&to=${today}`);
check("signed out CANNOT read profit analytics", r.status === 401, `got ${r.status}`);
r = await anon.req(`/api/export?report=profit-by-medicine&format=csv`);
check("signed out CANNOT export a financial report", r.status === 401, `got ${r.status}`);
r = await anon.req("/reports");
check("signed out is sent to the login page",
  r.status === 307 && (r.headers.get("location") ?? "").includes("/login"), `got ${r.status}`);

r = await admin.req(`/api/reports/analytics?from=${longAgo}&to=${today}`);
check("admin CAN read profit analytics", r.status === 200, `got ${r.status}`);
r = await admin.req("/alerts");
check("admin CAN open /alerts", r.status === 200, `got ${r.status}`);

console.log("\n8. Pages render");
for (const path of ["/reports", "/alerts", "/alerts?tab=stock", "/alerts?tab=dead",
                    "/reports?by=units", "/reports?preset=7d", "/dashboard"]) {
  r = await admin.req(path);
  check(`${path} renders`, r.status === 200, `got ${r.status}`);
}
r = await admin.req("/reports");
check("the reports page renders an SVG chart", String(r.body).includes("<svg"));
check("charts ship a table twin", String(r.body).includes("View as table"));

await mongo.close();
console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
process.exit(fail === 0 ? 0 : 1);
