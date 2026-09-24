import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Privacy policy",
  description:
    "How MantraMed collects, uses and protects the information pharmacies and their staff put into it.",
};

/**
 * Public privacy policy.
 *
 * Play Console requires a policy at a public URL for any app that handles
 * personal data, and this one handles health data - prescriptions carry the
 * patient's name, age and the doctor who wrote them. So the page is reachable
 * without a session (see PUBLIC_PATHS in middleware.ts) and renders as plain
 * server HTML that a store reviewer can read without signing in.
 *
 * It describes what the code actually stores. If a model gains a field that
 * identifies a person, or a new third party starts receiving data, this page
 * is out of date until it says so.
 */

const EFFECTIVE_DATE = "24 September 2026";
const CONTACT_EMAIL = "mantrasphere.official@gmail.com";
const COMPANY = "MantraSphere Innovations Pvt. Ltd.";

export default function PrivacyPage() {
  return (
    <div className="login-counter min-h-dvh px-4 py-10 sm:px-8">
      <div className="mx-auto w-full max-w-3xl">
        <Link href="/login" className="mb-8 flex items-center gap-3.5">
          <Image
            src="/mantramed-logo.png"
            alt=""
            width={1254}
            height={1254}
            priority
            className="h-14 w-14 shrink-0 object-contain"
          />
          <span className="min-w-0">
            <span className="block text-[22px] leading-none font-semibold tracking-tight text-slate-900">
              MantraMed
            </span>
            <span className="mt-1.5 block text-[10px] font-semibold tracking-[0.18em] text-brand-700 uppercase">
              Pharmacy Suite
            </span>
          </span>
        </Link>

        <article className="login-card px-5 py-7 sm:px-9 sm:py-9">
          <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-slate-900">
            Privacy policy
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            Effective {EFFECTIVE_DATE}
          </p>

          <div className="mt-6 space-y-4 text-[15px] leading-relaxed text-slate-700">
            <p>
              MantraMed is pharmacy billing and inventory software made by{" "}
              {COMPANY} (&ldquo;we&rdquo;, &ldquo;us&rdquo;). It runs on the web,
              as a Windows desktop app and as an Android app. This policy explains
              what information the service holds, why, and what control you have
              over it.
            </p>
            <p>
              MantraMed is used by pharmacies, not by the public. A pharmacy
              that signs up is responsible for the information it records about
              its own customers and patients. We store and process that
              information on the pharmacy&rsquo;s behalf and only to run the
              service for them.
            </p>
          </div>

          <Section title="1. Information we collect">
            <h3 className="font-semibold text-slate-900">Staff accounts</h3>
            <List
              items={[
                "Name, email address and role (owner, manager, cashier and so on).",
                "Your password, stored only as a one-way hash. We cannot read it.",
                "When you last signed in, and a record of the bills, returns, purchases and other entries you made. Every bill is recorded against the account that raised it.",
              ]}
            />

            <h3 className="mt-5 font-semibold text-slate-900">
              Pharmacy business details
            </h3>
            <List
              items={[
                "Trading and registered names, address, phone, email, PAN and VAT numbers, company registration and drug licence numbers.",
                "For account administration only: the owner's phone number and citizenship number. The pharmacy's staff cannot see these.",
              ]}
            />

            <h3 className="mt-5 font-semibold text-slate-900">
              Information pharmacies record about their customers
            </h3>
            <List
              items={[
                "Customers: name, phone, address, PAN number and notes.",
                "Prescriptions: patient name, phone, age and gender; the prescribing doctor's name, registration number and hospital; the medicines prescribed and dispensed.",
                "Sales, invoices, returns and amounts owed.",
              ]}
            />

            <h3 className="mt-5 font-semibold text-slate-900">
              Business records
            </h3>
            <p>
              Medicines, stock batches, suppliers, purchases, payments and
              expenses. These describe the business rather than people, but
              they can include supplier contact details.
            </p>
          </Section>

          <Section title="2. How we use it">
            <List
              items={[
                "To run the service: sign you in, raise and print bills, track stock and produce reports.",
                "To send account emails, such as password reset links.",
                "To keep the service secure, investigate misuse and fix faults.",
                "To meet legal obligations, such as keeping tax invoices.",
              ]}
            />
            <p className="mt-4">
              We do not sell personal information. We do not use it for
              advertising. We do not use customer or patient records for any
              purpose other than providing the service to the pharmacy that
              entered them.
            </p>
          </Section>

          <Section title="3. The Android app">
            <p>
              The Android app shows the same service as the website and stores
              the same information, on our servers, not on the phone. It asks
              for these permissions:
            </p>
            <List
              items={[
                "Bluetooth, only to print receipts to a Bluetooth thermal printer you choose. It is marked as never being used to find your location, and the app does not ask for location access.",
                "Internet, to reach the service.",
              ]}
            />
            <p className="mt-4">
              The app has no advertising or analytics code.
            </p>
          </Section>

          <Section title="4. Cookies and local storage">
            <p>
              When you sign in we set one secure, httpOnly session cookie. It
              keeps you signed in and expires after your session ends. We also
              store small interface preferences in your browser, such as which
              menus you left open. We do not use tracking or advertising
              cookies.
            </p>
          </Section>

          <Section title="5. Who else sees it">
            <p>We share information only with:</p>
            <List
              items={[
                "Service providers that host our servers and database and deliver our emails. They process data only to provide those services to us.",
                "Authorities, when the law requires it.",
                "A buyer or successor, if the business is sold or merged, under the same protections as this policy.",
              ]}
            />
            <p className="mt-4">
              Each pharmacy&rsquo;s data is kept separate. Staff of one
              pharmacy cannot see another pharmacy&rsquo;s records.
            </p>
          </Section>

          <Section title="6. How we protect it">
            <List
              items={[
                "All traffic uses HTTPS encryption.",
                "Passwords are hashed and never stored in readable form.",
                "Access inside a pharmacy is limited by role, so a cashier sees less than an owner.",
                "Password reset links expire and work only once.",
              ]}
            />
            <p className="mt-4">
              No system is perfectly secure. If a breach affects your
              information, we will tell the affected pharmacies without undue
              delay.
            </p>
          </Section>

          <Section title="7. How long we keep it">
            <p>
              We keep information while the pharmacy&rsquo;s account is active.
              Tax invoices and related records may need to be kept for as long
              as tax law requires. When a pharmacy closes its account, it can
              ask for a copy of its data, and we will then delete it, apart from
              anything we are legally required to keep.
            </p>
          </Section>

          <Section title="8. Your rights">
            <p>
              You can ask to see, correct or delete personal information about
              you.
            </p>
            <List
              items={[
                "If you are a pharmacy's staff member or owner, contact us directly.",
                "If you are a pharmacy's customer or patient, contact that pharmacy first. They control your records and can correct or delete them. You can also contact us and we will pass your request on.",
              ]}
            />
          </Section>

          <Section title="9. Children">
            <p>
              MantraMed is for pharmacy staff and is not intended for children.
              Pharmacies may record prescriptions for patients of any age as
              part of their normal work.
            </p>
          </Section>

          <Section title="10. Changes to this policy">
            <p>
              We will update the date at the top when this policy changes. If a
              change is significant, we will notify pharmacy owners before it
              takes effect.
            </p>
          </Section>

          <Section title="11. Contact">
            <p>
              {COMPANY}
              <br />
              Email:{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="font-medium text-brand-700 underline underline-offset-2"
              >
                {CONTACT_EMAIL}
              </a>
            </p>
          </Section>
        </article>

        <p className="mt-6 text-center text-[11px] text-slate-400">
          A product of {COMPANY}
        </p>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-9 text-[15px] leading-relaxed text-slate-700">
      <h2 className="mb-3 text-lg font-semibold tracking-tight text-slate-900">
        {title}
      </h2>
      {children}
    </section>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="mt-2 list-disc space-y-1.5 pl-5 marker:text-brand-600">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
