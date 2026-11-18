import type { NextConfig } from "next";

/*
  Security headers on every response.

  The CSP allows inline script and style because Next injects its own inline
  bootstrap and hydration data, and there is no nonce plumbing here; what it
  does lock down is where anything may load from (this origin only), that the
  site may never be framed (clickjacking), and that forms post only here.
  React dev mode needs 'unsafe-eval', so that is added outside production.
*/
const isDev = process.env.NODE_ENV !== "production";
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  // For browsers that predate frame-ancestors.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    // Camera stays on for scanning packs and bills; Bluetooth for the printer.
    value:
      "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(self)",
  },
  // Two years, every subdomain. Only meaningful over https; harmless locally.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Mongoose ships optional native/dynamic deps that the bundler should not trace.
  // tesseract.js starts its worker from a file path and sharp is native.
  serverExternalPackages: ["mongoose", "bcryptjs", "exceljs", "pdfkit", "tesseract.js", "sharp"],
  poweredByHeader: false,
  // Next 15 defaults dynamic RSC cache to 0s, so every sidebar click re-renders
  // the destination from scratch. 30s matches Next 14 and makes section
  // switching instant after the first visit.
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      {
        // The sign-in page has nothing worth indexing.
        source: "/login",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      {
        // Always revalidated, so a fixed worker reaches every browser on its
        // next visit instead of whenever a CDN copy happens to expire.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
    ];
  },
  experimental: {
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
  },
};

export default nextConfig;
