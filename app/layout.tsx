import type { Metadata, Viewport } from "next";
import { getSession } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { CapacitorBoot } from "@/components/native/CapacitorBoot";
import "./globals.css";

/**
 * The browser tab carries the pharmacy's own name, read from Settings rather
 * than baked in at build time, so renaming the shop renames the tab. The
 * lookup is cached for a few seconds and falls back to the environment
 * defaults if Mongo is unreachable - a title is never worth failing a page
 * over, least of all the sign-in page.
 */
export async function generateMetadata(): Promise<Metadata> {
  const session = await getSession();

  let titleName = "Pharmacy";
  if (session?.role === "superadmin") {
    titleName = "MantraSphere";
  } else if (session?.pharmacyId) {
    const settings = await getSettings(session.pharmacyId, session.pharmacyName);
    titleName = settings.businessName.trim() || session.pharmacyName.trim() || "Pharmacy";
  }

  return {
    title: {
      default: titleName,
      template: `%s | ${titleName}`,
    },
    description:
      "Point of sale and inventory management for pharmacies: FEFO batch dispensing, expiry tracking and VAT billing.",
    appleWebApp: {
      capable: true,
      title: titleName,
      statusBarStyle: "default",
    },
    formatDetection: { telephone: false },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0f766e",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        {children}
        <CapacitorBoot />
      </body>
    </html>
  );
}
