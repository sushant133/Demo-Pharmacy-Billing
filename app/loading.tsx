import { BrandLoading } from "@/components/BrandLoading";

/**
 * Shown while a top-level layout is still on the server - most visibly the
 * signed-in shell on a cold start of the Android app, or straight after
 * sign-in - so the screen carries the logo rather than going white.
 */
export default function RootLoading() {
  return <BrandLoading />;
}
