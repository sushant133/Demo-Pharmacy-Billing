# MantraPharma

Pharmacy management for Nepali retail pharmacies: point of sale, batch-level
inventory, FEFO dispensing, expiry control and 13% VAT billing.

A single Next.js 15 full-stack app — App Router pages, Route Handlers for the
API, MongoDB via Mongoose. One process, one deploy.

---

## Why the design is what it is

**FEFO is the centre of the system.** Medicine is not fungible: two lots of the
same drug have different expiry dates, costs and prices. So stock lives on
`Batch`, never on `Medicine`, and every sale runs through
[`lib/fefo.ts`](lib/fefo.ts) — a pure function that dispenses earliest-expiry
first, refuses expired lots outright, and splits a line across batches when one
lot cannot fill it. Being pure means the most business-critical logic in the
system is unit-testable without a database (40 tests in
[`tests/fefo.test.ts`](tests/fefo.test.ts)).

**The cashier never picks a batch.** The POS sends only
`{ medicineId, quantity }`. The server decides which lots leave the shelf and
returns them for preview before the sale is confirmed.

**The server owns pricing.** The POS never computes a total; it calls
`/api/sales/quote` and displays what the server says. The number the cashier
reads is always the number that will be charged.

**Stock enters only through a purchase.** Since Phase 2 there is no direct
batch-create route. A batch exists because a goods-received note was posted, so
every unit on a shelf is traceable to the supplier delivery it arrived on and to
what was actually paid for it. Costing lives in
[`lib/purchase-math.ts`](lib/purchase-math.ts) — pure, like FEFO, and tested the
same way (36 tests).

**Cost is frozen onto the sale, not looked up later.** Posting a repeat delivery
of a lot blends its cost by weighted average, so reading `Batch.costPrice` at
report time would value a January sale at March's cost. Phase 3 records
`unitCost` on every sale line at the moment of sale, which is what makes the
profit figures trustworthy.

**Alerts are graded against sales velocity.** "Below 20 units" says nothing on
its own — 20 boxes of a fast mover is a shortage, 20 of a slow one is half a
year's supply. [`lib/alert-rules.ts`](lib/alert-rules.ts) works in *days of
cover* wherever there is sales history, and falls back to a flat reorder level
when there is not (saying which rule it used).

---

## Requirements

- Node.js 20+ (developed on 24)
- MongoDB 6+ (a replica set is recommended in production — see
  [Transactions](#transactions))

---

## Running locally

```bash
npm install
cp .env.example .env.local        # then set AUTH_SECRET
npm run seed                      # sample catalogue + staff logins
npm run dev                       # http://localhost:3000
```

`.env.example` documents every variable. The only one you must set is
`AUTH_SECRET` (32+ characters); in development the app falls back to an
insecure default and refuses to start without one in production.

```bash
openssl rand -base64 48
```

### Seed login

`npm run seed` creates two accounts: the platform operator, and one sample
pharmacy with its owner login.

| Role        | Email                            | Password    | Can do                                      |
| ----------- | -------------------------------- | ----------- | ------------------------------------------- |
| Superadmin  | `superadmin@mantrapharma.local`  | `Super@123` | Create, suspend and reset pharmacy accounts |
| Admin       | `admin@mantrapharma.local`       | `Admin@123` | Run that one pharmacy — billing, stock, the lot |

Each pharmacy is a sealed tenant. Superadmin creates the owner account; the
owner signs in on the same screen and only ever sees their own catalogue,
stock, bills, suppliers and settings. Two pharmacies sharing the database
cannot read each other.

A shop this size is run from one counter by one person: the same hands bill,
dispense, receive the delivery and read the month's figures. Splitting that
person into a "pharmacist" who could not open the branch screen and a "cashier"
who could not see a margin only ever got in the way, so both were folded into
the pharmacy owner (admin).

A database seeded before that change is migrated with `npm run migrate:roles`
(a dry run; add `-- --apply` to write). It promotes every remaining account to
admin without deleting anyone, and sessions signed under an old role keep
working rather than dumping whoever is at the counter back at the login screen.
Pass `-- --apply --drop-demo-logins` to also delete the two demo accounts the
old seed created, whose passwords are printed above: promoting those would
otherwise leave two well-known logins holding every permission in the shop.
Bills and GRNs are unaffected either way — they store the name of whoever
entered them on the document itself.

Override the credentials with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` and
`SEED_SUPERADMIN_EMAIL` / `SEED_SUPERADMIN_PASSWORD`.
**Change these passwords before the system goes anywhere near a real counter.**

Existing single-shop databases need `npm run backfill:pharmacies -- --apply`
once, so every document attaches to a default pharmacy and a superadmin login
is created. Then open `/superadmin` to add more pharmacies.

`npm run seed` is additive and safe to re-run. `npm run seed:fresh` wipes
medicines, batches, sales, users, customers, suppliers, purchases and
pharmacies first.

The sample data is built to exercise the system immediately: 4 suppliers, 20
medicines, and 24 batches that arrive through **4 real posted GRNs** — the seed
calls the same `createPurchase()` service the app does, so it fails loudly if
the purchase flow ever breaks. Several medicines carry two lots so FEFO visibly
splits, one lot expires in about two months (expiry alert), one has already
expired (blocked from billing), one medicine sits below its reorder level (low
stock), some lines carry free-scheme units, and one invoice is settled in full
so the payables ledger shows both paid and unpaid states.

### Scripts

| Command              | What it does                                        |
| -------------------- | --------------------------------------------------- |
| `npm run dev`        | Dev server with hot reload                          |
| `npm run build`      | Production build                                    |
| `npm start`          | Serve the production build                          |
| `npm test`           | Unit tests for every pure module (Vitest)           |
| `npm run lint`       | ESLint (next/core-web-vitals + typescript)           |
| `npm run typecheck`  | `tsc --noEmit`, strict mode                         |
| `npm run seed`       | Load sample data                                    |
| `npm run seed:fresh` | Wipe, then load sample data                         |
| `npm run backfill:pharmacies` | Attach existing data to a default pharmacy (dry run) |
| `npm run smoke`      | Phase 1 end-to-end API check (server on port 3111)   |
| `npm run smoke:phase2` | Phase 2 purchasing end-to-end check                |
| `npm run smoke:phase3` | Phase 3 reporting/export end-to-end check          |
| `npm run backfill:cogs` | Fill in cost on pre-Phase-3 sales (dry run by default) |

The `smoke` scripts are development aids, not part of the test suite: seed
a fresh database, start the app on port 3111, then run one. They drive the real
HTTP API end to end.

- `smoke` (94 checks) — auth, RBAC, FEFO splitting, stock deduction, rollback,
  concurrent bill numbering, validation, customer linking, printable bill, and
  voiding a bill back onto its lots.
- `smoke:phase2` (76 checks) — the block on direct batch creation, supplier
  CRUD and ledger, draft/post/cancel lifecycle, GRN→batch linkage, free-scheme
  costing, weighted-average top-ups, payments, and purchasing access control.
- `smoke:phase3` (70 checks) — COGS capture surviving a cost top-up, analytics
  arithmetic, alert grading and ordering, all eight reports in all three
  formats, and the refusal of every financial route to a caller with no session.

Reseed between runs. Phases 1 and 2 assert exact post-seed stock levels, so seed
those two with `--no-sales`:

```bash
npx tsx scripts/seed.ts --fresh --no-sales   # then npm run smoke / smoke:phase2
npx tsx scripts/seed.ts --fresh              # then npm run smoke:phase3
```

---

## Deploying (PM2 + nginx + Cloudflare)

Same shape as your existing `lms-backend` and `project-backend`, but one
process instead of two.

```bash
git pull
npm ci
npm run build

# first time
pm2 start npm --name pharmacy -- start
pm2 save

# subsequent deploys
pm2 restart pharmacy
```

`next start` listens on port 3000 by default; `-- start -- -p 3005` if you need
another. Put your production values in `.env` (not `.env.local`) so PM2 picks
them up, and make sure `NODE_ENV=production` is set — the app refuses to sign
sessions with a weak `AUTH_SECRET` in production.

### nginx

```nginx
server {
    server_name pharmacy.example.com;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Session cookies are issued `Secure` in production. TLS is terminated at
Cloudflare/nginx, so keep Cloudflare SSL mode on **Full (strict)** — under
"Flexible" the browser would drop the cookie and logins would silently fail.

---

## Transactions

Stock deduction and the sale record must never desync. How that is guaranteed
depends on your MongoDB topology, and the app detects which at runtime:

- **Replica set or sharded cluster** — a real multi-document transaction,
  retried automatically on write conflicts.
- **Standalone `mongod`** — transactions are unavailable, so the app falls back
  to guarded atomic decrements: every deduction is
  `$inc: { quantity: -n }` filtered on `quantity: { $gte: n }`, which cannot
  drive a batch negative even under concurrent sales, plus compensating
  rollback if a later step fails.

The fallback is safe, but a single-node replica set is one command more and
gives you real atomicity:

```bash
# /etc/mongod.conf
replication:
  replSetName: rs0

# then, once:
mongosh --eval 'rs.initiate()'
```

Then point `MONGODB_URI` at `...?replicaSet=rs0`.

---

## Project structure

```
app/
  (app)/              authenticated screens (shared sidebar layout)
    dashboard/        today's takings, low stock, expiry alerts
    billing/          POS
    medicines/        catalogue + low-stock view
    batches/          stock register
    sales/            history and bill detail
    purchases/        GRN entry, register and detail
    suppliers/        supplier list and ledger
    reports/          sales & profit dashboard, export downloads
    alerts/           graded expiry / reorder / dead-stock centre
  api/                route handlers
  bills/[id]/         printable bill (outside the app chrome, on purpose)
  login/
lib/
  fefo.ts             FEFO allocation, stock return + VAT maths — pure, no I/O
  purchase-math.ts    purchase costing (free schemes, weighted avg) — pure
  alert-rules.ts      expiry grading, days-of-cover, reorder maths — pure
  chart-scale.ts      axis ticks, scales, SVG paths — pure
  analytics.ts        sales/profit aggregation
  alerts.ts           joins stock with sales velocity, runs the rules
  export/             dataset -> CSV / Excel / PDF renderers
  sales.ts            plan/commit a sale, stock deduction, void + return
  purchases.ts        create/post/cancel a GRN; the only path to new stock
  suppliers.ts        derived supplier balances and payments
  transaction.ts      transaction with standalone fallback
  db.ts               cached Mongoose connection
  auth.ts             route + page guards
  session.ts          JWT sign/verify (Edge-safe)
  roles.ts            roles and permissions
  settings.ts         the shop's own details, cached, with env fallback
  validation.ts       Zod schemas shared by forms and API
  reports.ts          dashboard + report queries
  constants.ts        domain enums (client-safe, no Mongoose)
models/               Mongoose schemas
components/           shared UI + client islands
scripts/              seed, smoke tests
tests/                unit tests for every pure module
middleware.ts         Edge auth gate
```

Server Components are the default. The client components are the ones that
genuinely need interactivity: the POS cart, the purchase entry grid, the login
form, the slide-over form panels, and the app shell (it needs the current
path). Everything else renders on the server and talks to MongoDB directly,
with no API round trip.

---

## Auth

Custom JWT in an httpOnly cookie rather than NextAuth. NextAuth v5 is still
beta on the App Router, and ~150 lines of `jose` gives typed sessions,
Edge-compatible middleware and no beta dependency.

Two layers, deliberately:

1. **`middleware.ts`** verifies the JWT signature at the edge with no database
   round trip, and bounces anonymous traffic before it reaches the app.
2. **Route handlers re-check permissions themselves** via
   `requirePermission("sale:create")`. Middleware is a fast filter, never the
   only line of defence.

Permissions are per-capability, not per-role-string. There is one role today
and it holds all of them, but every route still asks for the capability it
needs — which is what would make a narrower role a single table entry in
`lib/roles.ts` rather than an audit of every handler.

---

## API

Every endpoint returns the same envelope:

```jsonc
// success
{ "ok": true, "data": ..., "meta": { "page": 1, "total": 42 } }

// failure
{ "ok": false, "error": { "code": "INSUFFICIENT_STOCK", "message": "...", "details": ... } }
```

| Method | Route                                        | Permission       |
| ------ | -------------------------------------------- | ---------------- |
| POST   | `/api/auth/login`                            | public           |
| POST   | `/api/auth/logout`                           | public           |
| GET    | `/api/auth/me`                               | any session      |
| GET    | `/api/medicines?q=&category=&withStock=1`    | `medicine:read`  |
| POST   | `/api/medicines`                             | `medicine:write` |
| GET    | `/api/medicines/:id`                         | `medicine:read`  |
| PATCH  | `/api/medicines/:id`                         | `medicine:write` |
| DELETE | `/api/medicines/:id`                         | `medicine:delete`|
| GET    | `/api/batches?status=&medicineId=&q=`        | `batch:read`     |
| POST   | `/api/batches`                               | `batch:write`    |
| PATCH  | `/api/batches/:id`                           | `batch:write`    |
| DELETE | `/api/batches/:id`                           | `batch:delete`   |
| POST   | `/api/sales/quote`                           | `sale:create`    |
| POST   | `/api/sales`                                 | `sale:create`    |
| GET    | `/api/sales?from=&to=&paymentMode=&q=`       | `sale:read`      |
| GET    | `/api/sales/:id` (id **or** bill number)     | `sale:read`      |
| POST   | `/api/sales/:id/void` (id only)              | `sale:void`      |
| GET    | `/api/reports/low-stock?threshold=`          | `report:read`    |
| GET    | `/api/reports/expiring-soon?days=`           | `report:read`    |
| GET    | `/api/customers?q=`                          | `customer:read`  |
| POST   | `/api/customers`                             | `customer:write` |
| GET    | `/api/suppliers?q=&status=`                   | `supplier:read`  |
| POST   | `/api/suppliers`                             | `supplier:write` |
| GET    | `/api/suppliers/:id` (with derived balance)   | `supplier:read`  |
| PATCH  | `/api/suppliers/:id`                         | `supplier:write` |
| DELETE | `/api/suppliers/:id`                         | `supplier:delete`|
| GET    | `/api/suppliers/:id/payments`                | `supplier:read`  |
| POST   | `/api/suppliers/:id/payments`                | `payment:write`  |
| DELETE | `/api/payments/:id`                          | `payment:write`  |
| GET    | `/api/purchases?status=&supplierId=&q=`      | `purchase:read`  |
| POST   | `/api/purchases` (`?post=1` to receive now)   | `purchase:write` |
| GET    | `/api/purchases/:id` (id **or** GRN number)   | `purchase:read`  |
| PATCH  | `/api/purchases/:id` (drafts only)            | `purchase:write` |
| DELETE | `/api/purchases/:id` (drafts only)            | `purchase:write` |
| POST   | `/api/purchases/:id/post`                    | `purchase:post`  |
| POST   | `/api/purchases/:id/cancel`                  | `purchase:cancel`|
| GET    | `/api/reports/alerts?kind=expiry|stock|dead`  | `report:read`    |
| GET    | `/api/reports/analytics?from=&to=`            | `report:financial` |
| GET    | `/api/export?report=&format=csv|xlsx|pdf`     | `report:export`  |
| POST   | `/api/batches`                               | **removed** — 409 |

### Creating a sale

```jsonc
POST /api/sales
{
  "items": [{ "medicineId": "...", "quantity": 100 }],
  "discount": 50,
  "paymentMode": "esewa",
  "customerName": "Ram Karki"
}
```

Batch selection is the server's job. If total sellable stock is short the sale
is refused with `409 INSUFFICIENT_STOCK` and a message naming the medicine and
the real shortfall — expired units are reported separately, so "you have 240 in
stock but only 200 are sellable" is an explicit answer rather than a confusing
rejection.

`POST /api/sales/quote` takes the same items and returns the exact batches and
totals **without touching stock**. The POS calls it as the cart changes; the
sale re-plans at commit time, because another till may have sold the same lot
in the meantime.

### Voiding a bill

```jsonc
POST /api/sales/:id/void
{ "reason": "customer returned everything unopened" }
```

A void is the inverse of a sale: every dispensed line goes back onto the lot it
came from, and the bill drops out of takings, profit, COGS and sales-velocity
figures — all of which already filter `voidedAt: null`. The bill itself is
never deleted. It keeps its number, its lines and its prices, and gains a
timestamp, an author and the written reason, because a missing bill number is
exactly what an auditor asks about.

The response says what moved:

```jsonc
{ "ok": true, "data": {
    "billNo": "INV-000042",
    "restored":   [{ "batchNumber": "CTZ-2201", "quantity": 60 }],
    "unreturned": []
} }
```

`unreturned` should always be empty — a lot named on a bill cannot be deleted
through the app. It exists so that stock removed behind the app's back produces
a bill that is still correctly voided plus a message naming the lot to count by
hand, rather than a void that can never be performed at all.

The void is *claimed* with a guarded `voidedAt: null` update before any stock
moves. On a standalone MongoDB there is no transaction to serialise two clerks
pressing the button at once, so the first writer wins and the second gets a
409 — instead of both putting the same units back and inflating the lot.

---

## Reporting and export

`/reports` is a sales-and-profit dashboard; `/alerts` is the graded
expiry / reorder / dead-stock centre. Both are Server Components, and the charts
are **server-rendered inline SVG** — no charting library, no client JavaScript.
Hover is carried by native `<title>` elements and every chart ships a
"View as table" twin, so no value is reachable only by hovering.

Chart colours are assigned by slot in fixed order and validated for
colour-vision deficiency against the white chart surface (worst adjacent pair:
normal-vision ΔE 33.6, protan ΔE 24.7). They live as tokens in `globals.css`.

Eight reports export to **CSV, Excel (.xlsx) and PDF**:

| Report | What it covers |
| --- | --- |
| Sales register | One row per bill, with VAT, cost and profit |
| Sales detail | One row per dispensed line, with batch and expiry |
| Profit by medicine | Revenue, cost and margin per medicine |
| Stock valuation | Every lot on the shelf, at cost and at retail |
| Expiry | Batches graded by urgency, with value at risk |
| Reorder | What to order, with a suggested quantity |
| Purchase register | Deliveries received, with payment status |
| Supplier payables | What is owed, and what is overdue |

Each report is one function returning a format-neutral dataset; the three
renderers turn that into bytes. Adding a report changes nothing in the
exporters. Excel workbooks keep numbers numeric with rupee and percentage
formats, a frozen header and an autofilter — an accountant can sort and pivot
without retyping anything.

> **Phase 5 note:** PDFKit's built-in Helvetica has no Devanagari coverage, so
> Nepali output will need an embedded Unicode font registered in
> `lib/export/pdf.ts` before any Nepali text can render.

---

## Deliberate behaviours

Things that look like bugs but are decisions:

- **Expiry is inclusive.** A batch is sellable through its expiry date, matching
  how "EXP 03/2027" is read at the counter.
- **VAT is charged after discount.** Discount first, then 13% on the taxable
  amount — the Nepali convention.
- **Deleting a medicine with batch history deactivates it instead.** A hard
  delete would orphan batches and break reprints of old bills.
- **A batch that appears on any bill cannot be deleted at all.** Zero its
  quantity to take it off the shelf.
- **A voided bill is never deleted, and never renumbered.** It stays in the
  sales register flagged `Voided`, and prints with a VOID stamp saying it is
  not a demand for payment. Only the money and the stock are reversed.
- **A void has no time limit, and returns stock to expired lots too.** The
  units physically come back whatever the date, so the count must show them;
  FEFO is what refuses to dispense them again.
- **Voiding cannot be undone.** Re-ringing the sale is the correction, which
  keeps both the mistake and the fix visible in the register.
- **Voiding is gated on `sale:void`,** a capability of its own rather than a
  side effect of being able to sell: it moves stock and rewrites the day's
  takings.
- **Bill numbers come from an atomic counter,** not `count() + 1`, which races
  at a busy counter. Verified under concurrent load.
- **Sale lines denormalise medicine name, batch, expiry and price.** A bill
  reprinted next year must show what was actually charged.
- **Dates are resolved in `BUSINESS_TIMEZONE`** (default `Asia/Kathmandu`), so
  "today's sales" rolls over at local midnight, not at 05:45 on a UTC VPS.
- **A draft purchase creates no stock.** Nothing is on the shelf until the GRN
  is posted, so an invoice can be typed while the delivery is still being
  checked.
- **A posted GRN is immutable.** It has already created stock, so it is an
  accounting record from that point; corrections go through cancellation.
- **Cancelling a GRN is refused once any of its stock has been sold** — the
  remedy there is a purchase return (Phase 3), not a reversal.
- **Free scheme units lower the recorded cost.** "10 + 2 free" puts 12 units on
  the shelf at the cost of 10, so the batch stores the effective unit cost.
- **Re-receiving the same lot number tops it up at weighted-average cost**
  rather than overwriting: the units already on the shelf were bought at the
  old price.
- **Supplier balances are derived, never stored.** Opening balance + posted
  purchases − payments, computed on read, so the payables figure is always
  reconcilable against the underlying documents.
- **Revenue means the taxable amount, not the total collected.** VAT is held for
  the IRD; counting it as revenue would inflate every figure by 13%.
- **Cost and margin sit behind `report:financial`,** separate from
  `report:read`, so `/reports` and the profit columns can be closed off without
  also hiding the stock and expiry alerts the counter needs.
- **Bill-level discounts are pushed down to lines** in proportion to each line's
  share of the bill, so per-medicine profit is not credited with revenue the
  shop never received.
- **"Value at risk" is the portion that cannot sell before expiry**, at the
  medicine's current rate — not the whole lot. It is the number that decides
  whether acting is worth it.
- **CSV exports neutralise formula injection.** A cell beginning `=`, `+`, `-`
  or `@` is prefixed with a quote, because export content includes names typed
  at the counter and a spreadsheet would otherwise execute them.

---

## Keyboard shortcuts

Data entry speed is the point of a POS.

| Key  | Action                       |
| ---- | ---------------------------- |
| `F2` | Jump to billing from anywhere|
| `F4` | Focus the medicine search    |
| `F9` | Complete the sale            |
| `↑` `↓` `Enter` | Navigate and add search results |
| `Esc`| Close a panel                |

---

## Known issues

- `npm audit` reports a PostCSS advisory reachable only through Next's own
  bundled copy. It is build-time only, not runtime attack surface, and is not
  fixable without upgrading to Next 16 — a major-version move, so it is left
  for a deliberate upgrade rather than done silently.

---

## Status

Phases 1–3 are complete: **215 unit tests** and **240 end-to-end API checks**
(94 + 76 + 70) passing, clean ESLint, clean `tsc --noEmit` under strict mode,
and a clean production build.

Phase 4 Stage 1 is in place: a real branch registry, lots scoped to an
outlet, FEFO that only sees stock in the room, and an admin viewing-scope
switcher. Stock transfer and the offline queue are still ahead.

Printed bills are **IRD tax invoices** for an 80mm thermal printer: कर बीजक
heading, seller PAN, fiscal-year bill number, Bikram Sambat and AD dates,
buyer name/PAN, 13% VAT split, and the total in words (VAT Rules 2053 Rule 17).
Live CBMS upload still needs IRD-approved e-billing software and is not this
app. Set the PAN under **Settings** before going live; the invoice says so
itself until you do.

**Settings** holds the shop's own identity - trading name, registered name,
PAN, VAT registration and rate, DDA drug licence, company registration,
address and contacts, and the two lines printed at the foot of a bill. It is a
single record in the database, not an environment variable, because a name or
a PAN that is wrong on a tax invoice has to be fixable by the pharmacy rather
than by a redeploy. The screen previews the receipt live as you type. The
`BUSINESS_*` variables in `.env` are now only what a brand new install starts
from, and the fallback if Mongo cannot be reached.

A single-outlet pharmacy prints exactly what Settings says. Once a second
outlet is open, each branch's own name, address, phone and PAN take over
wherever it has them, because a VAT invoice must carry the identity of the
outlet that issued it.

Phase 5 still covers CBMS sync, audit logs, backup/restore and a Nepali
language toggle.

Existing databases need `npm run backfill:branches -- --apply` once, so
users, lots, bills and GRNs attach to the default outlet, and
`npm run backfill:pharmacies -- --apply` so every shop document attaches to a
pharmacy tenant and a superadmin login exists. The seed creates both itself.

**Not yet built, and deliberately so:** there is no purchase-return or
debit-note flow. Cancelling a GRN whose stock has been sold is refused, and the
documented workaround is a manual batch correction plus a direct settlement with
the supplier. That is a gap worth closing when the roadmap allows.

The customer-facing half of that pair now exists: voiding a bill puts its stock
back and reverses the money. Voiding every bill drawn from a lot also unblocks
cancelling the GRN that brought it in, since the refusal counts only bills that
are still live.
