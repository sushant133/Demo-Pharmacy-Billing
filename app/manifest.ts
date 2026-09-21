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
    icons: [
      {
        src: "/icon",
        sizes: "32x32",
        type: "image/png",
      },
    ],
  };
}
