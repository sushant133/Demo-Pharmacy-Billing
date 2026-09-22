import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MantraMed",
    short_name: "MantraMed",
    description: "Sales and thermal bills on a phone or till.",
    start_url: "/billing",
    display: "standalone",
    background_color: "#f1f5f9",
    theme_color: "#0f766e",
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
