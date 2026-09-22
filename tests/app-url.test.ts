import { describe, expect, it } from "vitest";
import { resolveAppUrl } from "@/lib/config";

/**
 * The origin in every emailed link. Getting it wrong sends owners to
 * localhost, which is exactly the bug this guards against.
 */
describe("resolveAppUrl", () => {
  it("defaults to localhost for local development", () => {
    expect(resolveAppUrl({})).toBe("http://localhost:3000");
  });

  it("uses APP_URL when it is set", () => {
    expect(resolveAppUrl({ APP_URL: "https://mantramed.tech/" })).toBe(
      "https://mantramed.tech",
    );
  });

  it("uses Vercel's production domain when APP_URL is missing", () => {
    expect(
      resolveAppUrl({
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: "mantramed.tech",
        VERCEL_URL: "demo-pharmacy-abc123.vercel.app",
      }),
    ).toBe("https://mantramed.tech");
  });

  it("ignores a localhost APP_URL copied onto Vercel", () => {
    expect(
      resolveAppUrl({
        VERCEL: "1",
        VERCEL_ENV: "production",
        APP_URL: "http://localhost:3000",
        VERCEL_PROJECT_PRODUCTION_URL: "mantramed.tech",
      }),
    ).toBe("https://mantramed.tech");
  });

  it("points a preview deploy at itself", () => {
    expect(
      resolveAppUrl({
        VERCEL: "1",
        VERCEL_ENV: "preview",
        VERCEL_PROJECT_PRODUCTION_URL: "mantramed.tech",
        VERCEL_URL: "demo-pharmacy-git-feature.vercel.app",
      }),
    ).toBe("https://demo-pharmacy-git-feature.vercel.app");
  });
});
