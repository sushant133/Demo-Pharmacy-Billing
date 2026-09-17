import { NextResponse } from "next/server";
import { ANDROID_RELEASE } from "@/lib/android-release";

/**
 * Version manifest polled by the Android app on launch.
 *
 * Served as a route rather than a static file so a deploy is all it takes to
 * publish a new version - there is no `public/` directory in this project and
 * nothing to upload by hand.
 *
 * Public on purpose: it carries no pharmacy data, and the app checks it
 * before anyone has signed in. `middleware.ts` lets it through.
 */
// Prerendered at build time: the app polls it on every launch, and a
// deploy is what publishes a new version anyway.
export const dynamic = "force-static";

export function GET() {
  return NextResponse.json(ANDROID_RELEASE, {
    headers: {
      // Long enough that launches are cheap, short enough that a release
      // reaches tills the same day.
      "cache-control": "public, max-age=300, s-maxage=300",
    },
  });
}
