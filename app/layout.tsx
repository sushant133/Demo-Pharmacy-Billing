import type { Metadata, Viewport } from "next";
import { getSettings } from "@/lib/settings";
import "./globals.css";

/**
 * The browser tab carries the pharmacy's own name, read from Settings rather
 * than baked in at build time, so renaming the shop renames the tab. The
 * lookup is cached for a few seconds and falls back to the environment
 * defaults if Mongo is unreachable - a title is never worth failing a page
 * over, least of all the sign-in page.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { businessName } = await getSettings();

  return {
    title: {
      default: `${businessName} - Pharmacy Management`,
      template: `%s | ${businessName}`,
    },
    description:
      "Point of sale and inventory management for pharmacies: FEFO batch dispensing, expiry tracking and VAT billing.",
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f766e",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
