/**
 * Seed script - realistic sample data for development and demos.
 *
 *   npm run seed          add anything missing, keep existing data
 *   npm run seed:fresh    wipe medicines/batches/sales/users first
 *   --no-sales            skip the sample sales (pristine stock for tests)
 *
 * Run with tsx (see package.json), not the Next runtime, so it can be used on
 * a server before the app is started.
 */

import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

import { connectDB } from "../lib/db";
import { ensureDefaultBranch } from "../lib/branches";
import { syncTenantIndexes } from "../lib/indexes";
import { Medicine } from "../models/Medicine";
import { Batch } from "../models/Batch";
import { Branch } from "../models/Branch";
import { Pharmacy } from "../models/Pharmacy";
import { Sale } from "../models/Sale";
import { User } from "../models/User";
import { Customer } from "../models/Customer";
import { Counter } from "../models/Counter";
import { Setting } from "../models/Setting";
import { Supplier } from "../models/Supplier";
import { Purchase } from "../models/Purchase";
import { SupplierPayment } from "../models/SupplierPayment";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { createPurchase } from "../lib/purchases";
import { createSale } from "../lib/sales";
import { recordPayment } from "../lib/suppliers";
import type { SessionUser } from "../lib/session";
import type { Role } from "../lib/roles";

const FRESH = process.argv.includes("--fresh");
/**
 * Skip the sample sales.
 *
 * The Phase 1 and Phase 2 smoke suites assert exact batch quantities straight
 * after seeding, so they need a shelf nothing has sold from yet.
 */
const NO_SALES = process.argv.includes("--no-sales");

/** Days from today, as a Date. Keeps the sample data relative to run time. */
function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

/** Last usable instant of the month `months` from now - how expiry is printed. */
function monthsFromNow(months: number): Date {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth() + months + 1, 0, 23, 59, 59);
  return target;
}

interface SeedMedicine {
  name: string;
  genericName: string;
  saltComposition: string;
  manufacturer: string;
  category: string;
  unit: string;
  packSize: string;
  requiresPrescription?: boolean;
  reorderLevel?: number;
  /** [batchNumber, quantity, costPrice, salePrice, monthsUntilExpiry] */
  batches: Array<[string, number, number, number, number]>;
}

/**
 * Twenty medicines commonly dispensed in Nepali retail pharmacies, with
 * plausible manufacturers and rupee pricing. Several deliberately carry more
 * than one batch, and a few carry a near-expiry or already-expired lot, so
 * FEFO, low-stock and expiry alerts all have something to show immediately.
 */
const MEDICINES: SeedMedicine[] = [
  {
    name: "Cetzine 10mg",
    genericName: "Cetirizine",
    saltComposition: "Cetirizine Hydrochloride 10mg",
    manufacturer: "Deurali-Janta",
    category: "Antihistamine",
    unit: "tablet",
    packSize: "10x10",
    batches: [
      // Two lots: FEFO must pick CTZ-2201 first even though it was added later.
      ["CTZ-2205", 180, 1.2, 2.5, 14],
      ["CTZ-2201", 60, 1.1, 2.5, 4],
    ],
  },
  {
    name: "Paracetamol 500mg",
    genericName: "Paracetamol",
    saltComposition: "Paracetamol 500mg",
    manufacturer: "Nepal Pharmaceuticals",
    category: "Antipyretic",
    unit: "tablet",
    packSize: "10x10",
    batches: [
      ["PCM-4410", 500, 0.8, 1.5, 18],
      ["PCM-4402", 240, 0.75, 1.5, 7],
    ],
  },
  {
    name: "Amoxyclav 625mg",
    genericName: "Amoxicillin + Clavulanic Acid",
    saltComposition: "Amoxicillin 500mg + Clavulanic Acid 125mg",
    manufacturer: "Lomus Pharmaceuticals",
    category: "Antibiotic",
    unit: "tablet",
    packSize: "1x10",
    requiresPrescription: true,
    batches: [["AMC-8801", 120, 18.5, 28.0, 16]],
  },
  {
    name: "Azithral 500mg",
    genericName: "Azithromycin",
    saltComposition: "Azithromycin 500mg",
    manufacturer: "Alkem",
    category: "Antibiotic",
    unit: "tablet",
    packSize: "1x3",
    requiresPrescription: true,
    batches: [["AZT-3390", 90, 32.0, 48.0, 20]],
  },
  {
    name: "Omez 20mg",
    genericName: "Omeprazole",
    saltComposition: "Omeprazole 20mg",
    manufacturer: "Dr. Reddy's",
    category: "Antacid",
    unit: "capsule",
    packSize: "10x10",
    batches: [
      ["OMZ-1120", 300, 2.1, 4.0, 22],
      ["OMZ-1108", 45, 2.0, 4.0, 2], // near-expiry, drives the expiry alert
    ],
  },
  {
    name: "Pantop 40mg",
    genericName: "Pantoprazole",
    saltComposition: "Pantoprazole Sodium 40mg",
    manufacturer: "Asian Pharmaceuticals",
    category: "Antacid",
    unit: "tablet",
    packSize: "10x10",
    batches: [["PNT-7712", 220, 3.4, 6.5, 19]],
  },
  {
    name: "Metformin 500mg",
    genericName: "Metformin",
    saltComposition: "Metformin Hydrochloride 500mg",
    manufacturer: "Time Pharmaceuticals",
    category: "Antidiabetic",
    unit: "tablet",
    packSize: "10x15",
    requiresPrescription: true,
    reorderLevel: 100,
    batches: [["MET-5540", 400, 1.6, 3.0, 24]],
  },
  {
    name: "Amlodipine 5mg",
    genericName: "Amlodipine",
    saltComposition: "Amlodipine Besylate 5mg",
    manufacturer: "Deurali-Janta",
    category: "Antihypertensive",
    unit: "tablet",
    packSize: "10x10",
    requiresPrescription: true,
    batches: [["AML-2231", 260, 1.4, 2.8, 21]],
  },
  {
    name: "Losartan 50mg",
    genericName: "Losartan Potassium",
    saltComposition: "Losartan Potassium 50mg",
    manufacturer: "Lomus Pharmaceuticals",
    category: "Antihypertensive",
    unit: "tablet",
    packSize: "10x10",
    requiresPrescription: true,
    batches: [["LOS-6690", 180, 2.9, 5.5, 17]],
  },
  {
    name: "Atorvastatin 10mg",
    genericName: "Atorvastatin",
    saltComposition: "Atorvastatin Calcium 10mg",
    manufacturer: "Sun Pharma",
    category: "Cardiac",
    unit: "tablet",
    packSize: "10x10",
    requiresPrescription: true,
    batches: [["ATV-9910", 150, 4.2, 7.5, 15]],
  },
  {
    name: "Benadryl Cough Syrup",
    genericName: "Diphenhydramine",
    saltComposition: "Diphenhydramine HCl 14mg + Ammonium Chloride 138mg / 5ml",
    manufacturer: "Johnson & Johnson",
    category: "Respiratory",
    unit: "syrup",
    packSize: "100ml",
    batches: [["BDY-0455", 48, 118.0, 165.0, 13]],
  },
  {
    name: "Ambrolite-D Syrup",
    genericName: "Ambroxol + Guaiphenesin",
    saltComposition: "Ambroxol 15mg + Guaiphenesin 50mg / 5ml",
    manufacturer: "Nepal Pharmaceuticals",
    category: "Respiratory",
    unit: "syrup",
    packSize: "100ml",
    batches: [["AMB-3312", 30, 92.0, 135.0, 9]],
  },
  {
    name: "Ceftriaxone 1g Injection",
    genericName: "Ceftriaxone",
    saltComposition: "Ceftriaxone Sodium 1g",
    manufacturer: "Lomus Pharmaceuticals",
    category: "Antibiotic",
    unit: "injection",
    packSize: "1 vial",
    requiresPrescription: true,
    reorderLevel: 15,
    batches: [["CFT-7701", 24, 78.0, 115.0, 11]],
  },
  {
    name: "Diclofenac Gel",
    genericName: "Diclofenac Diethylamine",
    saltComposition: "Diclofenac Diethylamine 1.16% w/w",
    manufacturer: "Novartis",
    category: "Analgesic",
    unit: "ointment",
    packSize: "30g",
    batches: [["DIC-4420", 40, 96.0, 140.0, 16]],
  },
  {
    name: "Betnovate-N Cream",
    genericName: "Betamethasone + Neomycin",
    saltComposition: "Betamethasone Valerate 0.1% + Neomycin 0.5%",
    manufacturer: "GSK",
    category: "Dermatology",
    unit: "cream",
    packSize: "20g",
    requiresPrescription: true,
    batches: [["BET-1180", 35, 62.0, 95.0, 12]],
  },
  {
    name: "Moxifloxacin Eye Drops",
    genericName: "Moxifloxacin",
    saltComposition: "Moxifloxacin HCl 0.5% w/v",
    manufacturer: "Alcon",
    category: "Ophthalmic",
    unit: "drops",
    packSize: "5ml",
    requiresPrescription: true,
    reorderLevel: 10,
    // Only 8 units left, below its reorder level: shows up in low stock.
    batches: [["MOX-2290", 8, 138.0, 195.0, 10]],
  },
  {
    name: "ORS Sachet",
    genericName: "Oral Rehydration Salts",
    saltComposition: "WHO ORS formula 21.8g",
    manufacturer: "Nepal Pharmaceuticals",
    category: "Supplement",
    unit: "sachet",
    packSize: "1 sachet",
    batches: [
      ["ORS-8890", 200, 8.0, 15.0, 20],
      // Already expired: must never be dispensed, and shows on the expired tab.
      ["ORS-8801", 40, 7.5, 15.0, -2],
    ],
  },
  {
    name: "Calcium + Vitamin D3",
    genericName: "Calcium Carbonate + Cholecalciferol",
    saltComposition: "Calcium Carbonate 500mg + Vitamin D3 250IU",
    manufacturer: "Time Pharmaceuticals",
    category: "Supplement",
    unit: "tablet",
    packSize: "1x15",
    batches: [["CAL-6620", 300, 3.8, 7.0, 23]],
  },
  {
    name: "Iron + Folic Acid",
    genericName: "Ferrous Fumarate + Folic Acid",
    saltComposition: "Ferrous Fumarate 152mg + Folic Acid 0.5mg",
    manufacturer: "Deurali-Janta",
    category: "Supplement",
    unit: "tablet",
    packSize: "10x10",
    batches: [["IFA-3340", 260, 1.9, 3.5, 18]],
  },
  {
    name: "Salbutamol Inhaler",
    genericName: "Salbutamol",
    saltComposition: "Salbutamol Sulphate 100mcg / dose",
    manufacturer: "Cipla",
    category: "Respiratory",
    unit: "inhaler",
    packSize: "200 doses",
    requiresPrescription: true,
    reorderLevel: 12,
    batches: [["SAL-5510", 18, 245.0, 340.0, 14]],
  },
];

/**
 * Four distributors, the shape a Kathmandu pharmacy actually deals with:
 * a couple of large national wholesalers on credit terms, and smaller ones
 * that sell cash-on-delivery.
 */
const SUPPLIERS = [
  {
    name: "Everest Pharma Distributors",
    contactPerson: "Rajesh Shrestha",
    phone: "9851011223",
    email: "orders@everestpharma.com.np",
    address: "Teku, Kathmandu",
    panNo: "301234567",
    paymentTermsDays: 30,
    openingBalance: 0,
  },
  {
    name: "Himalayan Medico Suppliers",
    contactPerson: "Sunita Karki",
    phone: "9801122334",
    email: "info@himalayanmedico.com.np",
    address: "New Road, Kathmandu",
    panNo: "302345678",
    paymentTermsDays: 45,
    openingBalance: 12500,
  },
  {
    name: "Kathmandu Drug House",
    contactPerson: "Bibek Tamang",
    phone: "9841556677",
    email: "sales@kdh.com.np",
    address: "Kalimati, Kathmandu",
    panNo: "303456789",
    paymentTermsDays: 15,
    openingBalance: 0,
  },
  {
    name: "Nepal Health Traders",
    contactPerson: "Prakash Adhikari",
    phone: "9856778899",
    address: "Bhaktapur",
    panNo: "304567890",
    paymentTermsDays: 0,
    openingBalance: 0,
  },
];

/** Which distributor each manufacturer's stock comes through. */
const SUPPLIER_FOR_MANUFACTURER: Record<string, string> = {
  "Deurali-Janta": "Everest Pharma Distributors",
  "Nepal Pharmaceuticals": "Everest Pharma Distributors",
  "Lomus Pharmaceuticals": "Everest Pharma Distributors",
  "Time Pharmaceuticals": "Kathmandu Drug House",
  "Asian Pharmaceuticals": "Kathmandu Drug House",
  Alkem: "Himalayan Medico Suppliers",
  "Dr. Reddy's": "Himalayan Medico Suppliers",
  "Sun Pharma": "Himalayan Medico Suppliers",
  Cipla: "Himalayan Medico Suppliers",
  "Johnson & Johnson": "Nepal Health Traders",
  Novartis: "Nepal Health Traders",
  GSK: "Nepal Health Traders",
  Alcon: "Nepal Health Traders",
};

const SUPERADMIN = {
  name: "Platform Superadmin",
  email: process.env.SEED_SUPERADMIN_EMAIL ?? "superadmin@mantrapharma.local",
  password: process.env.SEED_SUPERADMIN_PASSWORD ?? "Super@123",
};

const SAMPLE_PHARMACY = {
  name: DEFAULT_SETTINGS.businessName,
  slug: "mantra-pharmacy",
  ownerName: "Sushant Mahato",
  ownerEmail: process.env.SEED_ADMIN_EMAIL ?? "admin@mantrapharma.local",
  ownerPassword: process.env.SEED_ADMIN_PASSWORD ?? "Admin@123",
};

const CUSTOMERS = [
  { name: "Ram Bahadur Karki", phone: "9841000111", address: "Baneshwor, Kathmandu" },
  { name: "Sita Gurung", phone: "9802345678", address: "Lalitpur" },
  { name: "Hari Prasad Sharma", phone: "9856012345", address: "Bhaktapur" },
];

async function main() {
  console.log("Connecting to MongoDB…");
  await connectDB();
  console.log(`Connected to ${mongoose.connection.name}`);

  if (FRESH) {
    console.log("--fresh: clearing existing data…");
    await Promise.all([
      Medicine.deleteMany({}),
      Batch.deleteMany({}),
      Sale.deleteMany({}),
      User.deleteMany({}),
      Customer.deleteMany({}),
      Counter.deleteMany({}),
      Supplier.deleteMany({}),
      Purchase.deleteMany({}),
      SupplierPayment.deleteMany({}),
      Branch.deleteMany({}),
      Setting.deleteMany({}),
      Pharmacy.deleteMany({}),
    ]);
  }

  await syncTenantIndexes();

  // --- Superadmin ---------------------------------------------------------
  const existingSuper = await User.findOne({ email: SUPERADMIN.email });
  if (existingSuper) {
    if (existingSuper.role !== "superadmin") {
      existingSuper.role = "superadmin";
      existingSuper.pharmacyId = null;
      existingSuper.branchId = null;
      await existingSuper.save();
    }
    console.log(`  superadmin ${SUPERADMIN.email} already exists`);
  } else {
    await User.create({
      name: SUPERADMIN.name,
      email: SUPERADMIN.email,
      passwordHash: await bcrypt.hash(SUPERADMIN.password, 12),
      role: "superadmin",
    });
    console.log(`  + superadmin ${SUPERADMIN.email}`);
  }

  // --- Sample pharmacy ----------------------------------------------------
  let pharmacy = await Pharmacy.findOne({ slug: SAMPLE_PHARMACY.slug });
  if (!pharmacy) {
    const [created] = await Pharmacy.create([
      {
        name: SAMPLE_PHARMACY.name,
        slug: SAMPLE_PHARMACY.slug,
        status: "active",
        ownerName: SAMPLE_PHARMACY.ownerName,
        ownerEmail: SAMPLE_PHARMACY.ownerEmail,
      },
    ]);
    pharmacy = created!;
    console.log(`  + pharmacy ${pharmacy.name}`);
  } else {
    console.log(`  pharmacy ${pharmacy.name} already exists`);
  }

  const pharmacyId = pharmacy._id;

  const settingsExisted = await Setting.findOne({
    pharmacyId,
    key: "business",
  }).lean();
  if (settingsExisted) {
    console.log("  shop settings already present, keeping them");
  } else {
    await Setting.create({ pharmacyId, key: "business", ...DEFAULT_SETTINGS });
    console.log(`  shop settings created (${DEFAULT_SETTINGS.businessName})`);
  }

  const mainBranch = await ensureDefaultBranch(pharmacyId);
  console.log(`  default branch ${mainBranch.code} (${mainBranch.name})`);

  function asSession(
    user: { _id: unknown; name: string; email: string; role: string },
  ): SessionUser {
    return {
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role as Role,
      pharmacyId: String(pharmacyId),
      pharmacyName: pharmacy!.name,
      pharmacySlug: pharmacy!.slug,
      branchId: String(mainBranch._id),
      branchCode: mainBranch.code,
      branchName: mainBranch.name,
    };
  }

  // --- Pharmacy owner -----------------------------------------------------
  const existingOwner = await User.findOne({ email: SAMPLE_PHARMACY.ownerEmail });
  if (existingOwner) {
    if (!existingOwner.pharmacyId) existingOwner.pharmacyId = pharmacyId;
    if (!existingOwner.branchId) existingOwner.branchId = mainBranch._id;
    if (existingOwner.role !== "admin") existingOwner.role = "admin";
    await existingOwner.save();
    if (!pharmacy.ownerUserId) {
      pharmacy.ownerUserId = existingOwner._id;
      await pharmacy.save();
    }
    console.log(`  owner ${SAMPLE_PHARMACY.ownerEmail} ready`);
  } else {
    const owner = await User.create({
      name: SAMPLE_PHARMACY.ownerName,
      email: SAMPLE_PHARMACY.ownerEmail,
      passwordHash: await bcrypt.hash(SAMPLE_PHARMACY.ownerPassword, 12),
      role: "admin",
      pharmacyId,
      branchId: mainBranch._id,
    });
    pharmacy.ownerUserId = owner._id;
    await pharmacy.save();
    console.log(`  + ${SAMPLE_PHARMACY.ownerEmail}`);
  }

  // --- Customers ----------------------------------------------------------
  for (const customer of CUSTOMERS) {
    await Customer.updateOne(
      { pharmacyId, phone: customer.phone },
      { $setOnInsert: { ...customer, pharmacyId } },
      { upsert: true },
    );
  }
  console.log(`  ${CUSTOMERS.length} customers ready`);

  // --- Suppliers -----------------------------------------------------------
  for (const supplier of SUPPLIERS) {
    await Supplier.updateOne(
      { pharmacyId, name: supplier.name },
      { $setOnInsert: { ...supplier, pharmacyId } },
      { upsert: true },
    );
  }
  console.log(`  ${SUPPLIERS.length} suppliers ready`);

  // --- Medicine catalogue --------------------------------------------------
  let medicineCount = 0;
  const medicineIdByName = new Map<string, string>();

  for (const seed of MEDICINES) {
    const { batches: _batches, ...details } = seed;

    const medicine = await Medicine.findOneAndUpdate(
      { pharmacyId, name: details.name, manufacturer: details.manufacturer },
      { $setOnInsert: { ...details, pharmacyId } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    medicineIdByName.set(details.name, String(medicine._id));
    medicineCount++;
  }
  console.log(`  ${medicineCount} medicines in the catalogue`);

  // --- Stock, via real purchases ------------------------------------------
  //
  // Since Phase 2 stock exists only because a GRN was posted, so the seed
  // goes through the same createPurchase() service the app uses rather than
  // inserting batches behind its back. That keeps the sample data honest -
  // every seeded unit is traceable to a supplier delivery - and means this
  // script fails loudly if the purchase flow ever breaks.

  const existingBatches = await Batch.countDocuments({ pharmacyId });
  let grnCount = 0;
  let batchCount = 0;

  if (existingBatches > 0) {
    console.log("  stock already present, skipping purchase creation");
  } else {
    const adminUser = await User.findOne({ role: "admin", pharmacyId }).lean();
    if (!adminUser) throw new Error("No admin user to record purchases against.");

    const actor = asSession(adminUser);

    // Group every seeded lot into one delivery per supplier.
    const bySupplier = new Map<string, SeedMedicine[]>();
    for (const seed of MEDICINES) {
      const supplierName = SUPPLIER_FOR_MANUFACTURER[seed.manufacturer] ?? SUPPLIERS[0]!.name;
      const group = bySupplier.get(supplierName);
      if (group) group.push(seed);
      else bySupplier.set(supplierName, [seed]);
    }

    for (const [supplierName, seeds] of bySupplier) {
      const supplier = await Supplier.findOne({ pharmacyId, name: supplierName })
        .select("_id")
        .lean();
      if (!supplier) continue;

      const items = seeds.flatMap((seed) =>
        seed.batches.map(([batchNumber, quantity, costPrice, salePrice, months]) => ({
          medicineId: medicineIdByName.get(seed.name)!,
          batchNumber,
          // Manufactured roughly two years before expiry, as is typical.
          mfgDate: daysFromNow(months * 30 - 730),
          expiryDate: monthsFromNow(months),
          quantity,
          // A couple of lines carry a "10 + 1 free" style scheme so the
          // effective-cost maths has something real to chew on.
          freeQuantity: quantity >= 200 ? Math.floor(quantity / 20) : 0,
          costPrice,
          salePrice,
          discount: 0,
        })),
      );

      const created = await createPurchase(
        {
          supplierId: String(supplier._id),
          invoiceNo: `INV/${supplierName.slice(0, 3).toUpperCase()}/${1000 + grnCount}`,
          invoiceDate: daysFromNow(-7),
          receivedDate: daysFromNow(-7),
          items,
          discount: 0,
          otherCharges: 0,
          vatRate: 0.13,
          notes: "Opening stock, loaded by the seed script.",
        },
        actor,
        true, // post immediately - this is what creates the batches
      );

      grnCount++;
      batchCount += items.length;

      // Settle the first delivery in full so the ledger shows both states.
      if (grnCount === 1) {
        await recordPayment(
          {
            supplierId: String(supplier._id),
            purchaseId: created.id,
            amount: created.totalAmount,
            method: "bank-transfer",
            paidOn: daysFromNow(-3),
            reference: "SEED-PAY-001",
            note: "Paid in full.",
          },
          actor,
        );
      }
    }

    console.log(`  ${grnCount} purchases posted, creating ${batchCount} batches`);
  }

  // --- Sample sales -------------------------------------------------------
  //
  // Generated through the real createSale() service so FEFO runs, stock is
  // deducted, and cost is captured on every line - which is what makes the
  // profit dashboard show something truthful rather than invented numbers.
  //
  // Only the createdAt is rewritten afterwards, to spread the bills across the
  // last two months; everything else went through the production path.
  const existingSales = await Sale.countDocuments({ pharmacyId });
  let saleCount = 0;

  if (NO_SALES) {
    console.log("  --no-sales: skipping sample sales");
  } else if (existingSales > 0) {
    console.log("  sales already present, skipping");
  } else {
    // Whoever is at the counter sells, and that is the one account there is.
    const sellerUser = await User.findOne({ role: "admin", pharmacyId }).lean();
    if (!sellerUser) throw new Error("No admin user to record sales against.");
    const seller: SessionUser = asSession(sellerUser);

    const sellable = await Batch.find({ pharmacyId, quantity: { $gt: 0 } })
      .select("medicineId")
      .lean();
    const medicineIds = [...new Set(sellable.map((b) => String(b.medicineId)))];

    const customers = await Customer.find({ pharmacyId }).select("_id name").lean();
    const modes = ["cash", "cash", "cash", "esewa", "khalti", "card"] as const;

    // Deterministic pseudo-random, so a reseed produces the same demo data.
    let seedValue = 20260829;
    const rand = () => {
      seedValue = (seedValue * 1103515245 + 12345) % 2147483648;
      return seedValue / 2147483648;
    };

    const DAYS = 60;
    for (let dayOffset = DAYS; dayOffset >= 0; dayOffset--) {
      // Busier towards the present, and quieter on every seventh day.
      const isQuiet = dayOffset % 7 === 3;
      const billsToday = isQuiet ? 1 + Math.floor(rand() * 2) : 2 + Math.floor(rand() * 5);

      for (let bill = 0; bill < billsToday; bill++) {
        const lineCount = 1 + Math.floor(rand() * 3);
        const items: Array<{ medicineId: string; quantity: number }> = [];
        const used = new Set<string>();

        for (let line = 0; line < lineCount; line++) {
          const id = medicineIds[Math.floor(rand() * medicineIds.length)];
          if (!id || used.has(id)) continue;
          used.add(id);
          items.push({ medicineId: id, quantity: 1 + Math.floor(rand() * 6) });
        }
        if (items.length === 0) continue;

        const customer = rand() > 0.7 ? customers[Math.floor(rand() * customers.length)] : null;

        try {
          const sale = await createSale(
            {
              items,
              customerId: customer ? String(customer._id) : null,
              customerName: customer?.name ?? "",
              discount: 0,
              // Roughly one bill in seven gets a round percentage off, the way
              // a counter actually gives one.
              discountPercent: rand() > 0.85 ? [5, 10, 15][Math.floor(rand() * 3)] ?? 5 : 0,
              paymentMode: modes[Math.floor(rand() * modes.length)] ?? "cash",
              note: "",
            },
            seller,
          );

          const when = daysFromNow(-dayOffset);
          when.setHours(9 + Math.floor(rand() * 10), Math.floor(rand() * 60), 0, 0);
          await Sale.updateOne({ _id: sale.id }, { $set: { createdAt: when } });
          saleCount++;
        } catch {
          // A line can legitimately outrun the stock the seed created; skip it
          // rather than aborting the whole run.
        }
      }
    }

    console.log(`  ${saleCount} sample sales across the last ${DAYS} days`);
  }

  const [totalMedicines, totalBatches, totalUnits] = await Promise.all([
    Medicine.countDocuments({ pharmacyId }),
    Batch.countDocuments({ pharmacyId }),
    Batch.aggregate([
      { $match: { pharmacyId } },
      { $group: { _id: null, units: { $sum: "$quantity" } } },
    ]),
  ]);

  console.log("\nSeed complete.");
  console.log(`  medicines : ${totalMedicines}`);
  console.log(`  batches   : ${totalBatches}`);
  console.log(`  units     : ${(totalUnits[0]?.units as number) ?? 0}`);
  console.log("\nSign in with:");
  console.log(`  superadmin  ${SUPERADMIN.email}  /  ${SUPERADMIN.password}`);
  console.log(
    `  pharmacy    ${SAMPLE_PHARMACY.ownerEmail}  /  ${SAMPLE_PHARMACY.ownerPassword}`,
  );
  console.log(
    "\nChange these passwords before putting the system in front of customers.",
  );

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("\nSeed failed:", error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
