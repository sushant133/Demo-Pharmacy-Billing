import type { Metadata, Viewport } from "next";
import { getSession } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { CapacitorBoot } from "@/components/native/CapacitorBoot";
import "./globals.css";

/**
 * The browser tab carries the pharmacy's own name once one is known, read
 * from Settings rather than baked in at build time, so renaming the shop
 * renames the tab. Before sign-in it carries the product. The
 * lookup is cached for a few seconds and falls back to the environment
 * defaults if Mongo is unreachable - a title is never worth failing a page
 * over, least of all the sign-in page.
 */
export async function generateMetadata(): Promise<Metadata> {
  const session = await getSession();

  // At the door, and for a superadmin who belongs to no shop, the tab carries
  // the product. Naming one tenant there would be wrong for every other
  // vendor signing in through the same URL.
  let titleName = "MantraMed";
  if (session?.pharmacyId) {
    const settings = await getSettings(session.pharmacyId, session.pharmacyName);
    titleName = settings.businessName.trim() || session.pharmacyName.trim() || "MantraMed";
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

/*
  Lifts the Android splash on the first painted frame of server-rendered HTML
  - the page, or its loading skeleton - rather than after every JavaScript
  chunk has downloaded and hydrated, which on a counter's phone connection
  was most of the time spent looking at the logo. Inline, because it has to
  run before any bundle. It reads the bridge Capacitor injects at document
  start and does nothing in a browser. CapacitorBoot still hides the splash
  too, in case this runs before the bridge has its plugins.
*/
const EARLY_SPLASH_HIDE = `(function(){try{var C=window.Capacitor;if(!C||!C.isNativePlatform||!C.isNativePlatform())return;var S=C.Plugins&&C.Plugins.SplashScreen;if(!S||!S.hide)return;requestAnimationFrame(function(){requestAnimationFrame(function(){var p=S.hide();if(p&&p.catch)p.catch(function(){})})})}catch(e){}})();`;

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
        {/*
          Grounds behind the status bar and the navigation bar. The app draws
          edge to edge, and Android 15 makes both bars transparent, so a page
          scrolled under them showed through behind the clock and the back /
          home buttons. Each is exactly the inset tall - zero, and invisible,
          wherever there is no system bar. Above the page and its sticky bars
          (z-30), below the menu drawer (z-40) and dialogs (z-50), which pad
          themselves.
        */}
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-x-0 top-0 z-[35] h-[var(--safe-top)] bg-white print:hidden"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-x-0 bottom-0 z-[35] h-[var(--safe-bottom)] bg-white/95 print:hidden"
        />
        {/* After the page, so the frame it waits for has the page in it. */}
        <script dangerouslySetInnerHTML={{ __html: EARLY_SPLASH_HIDE }} />
        <CapacitorBoot />
      </body>
    </html>
  );
}

