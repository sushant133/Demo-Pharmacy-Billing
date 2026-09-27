import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Mongoose ships optional native/dynamic deps that the bundler should not trace.
  serverExternalPackages: ["mongoose", "bcryptjs", "exceljs", "pdfkit"],
  poweredByHeader: false,
  // Next 15 defaults dynamic RSC cache to 0s, so every sidebar click re-renders
  // the destination from scratch. 30s matches Next 14 and makes section
  // switching instant after the first visit.
  async headers() {
    return [
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
