import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    // A stable identity, so a later start_url change is an update to the
    // installed app rather than a second install beside it.
    id: "/",
    name: "MantraMed",
    short_name: "MantraMed",
    description:
      "Pharmacy billing, stock and expiry tracking for the counter - on a phone, tablet or till.",
    lang: "en",
    dir: "ltr",
    // Middleware sends a signed-out visitor to /login and brings them back.
    start_url: "/billing",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "any",
    background_color: "#ffffff",
    theme_color: "#0f766e",
    categories: ["business", "medical", "productivity"],
    prefer_related_applications: false,
    /*
      Built from the master logo by scripts/generate-icons.ts. Opaque white
      squares with the mark inset, because Android masks a home-screen icon
      into a circle or squircle of its choosing - art running to the edge
      loses its corners, and a transparent ground mattes onto black.

      The inset is generous enough to survive the mask, so the same file
      serves both purposes. They are listed twice rather than as the spec's
      "any maskable" because Next's Manifest type takes one purpose per
      entry.
    */
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
