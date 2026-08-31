import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Mongoose ships optional native/dynamic deps that the bundler should not trace.
  serverExternalPackages: ["mongoose", "bcryptjs", "exceljs", "pdfkit"],
  poweredByHeader: false,
  // Next 15 defaults dynamic RSC cache to 0s, so every sidebar click re-renders
  // the destination from scratch. 30s matches Next 14 and makes section
  // switching instant after the first visit.
  experimental: {
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
  },
};

export default nextConfig;
