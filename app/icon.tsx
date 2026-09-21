import { ImageResponse } from "next/og";
import { getSession } from "@/lib/auth";
import { brandLetter } from "@/lib/format";
import { getSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/**
 * Tab icon follows whoever is signed in: the pharmacy's initial after an
 * owner logs in, and the product's own M for superadmin or at the door,
 * where no shop is known yet.
 */
export default async function Icon() {
  const session = await getSession();

  let name = "MantraMed";
  if (session?.pharmacyId) {
    const settings = await getSettings(session.pharmacyId, session.pharmacyName);
    name = settings.businessName.trim() || session.pharmacyName.trim() || "MantraMed";
  }

  const letter = brandLetter(name);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0f766e",
          color: "#ffffff",
          fontSize: 18,
          fontWeight: 700,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        {letter}
      </div>
    ),
    { ...size },
  );
}
