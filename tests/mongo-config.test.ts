import { describe, expect, it } from "vitest";
import { dbNameFromMongoUri, unquoteEnv } from "@/lib/config";

describe("unquoteEnv", () => {
  it("strips wrapping double or single quotes", () => {
    expect(unquoteEnv('"abc"')).toBe("abc");
    expect(unquoteEnv("'abc'")).toBe("abc");
    expect(unquoteEnv("  abc  ")).toBe("abc");
  });
});

describe("dbNameFromMongoUri", () => {
  it("reads the path from a local URI", () => {
    expect(dbNameFromMongoUri("mongodb://127.0.0.1:27017/mantrapharma")).toBe(
      "mantrapharma",
    );
  });

  it("reads the path from a multi-host Atlas URI", () => {
    const uri =
      "mongodb://user:pass@h0.mongodb.net:27017,h1.mongodb.net:27017/DemopharmaDB?ssl=true&replicaSet=atlas-x";
    expect(dbNameFromMongoUri(uri)).toBe("DemopharmaDB");
  });

  it("returns undefined when Atlas omits the path", () => {
    const uri =
      "mongodb://user:pass@h0.mongodb.net:27017,h1.mongodb.net:27017/?ssl=true";
    expect(dbNameFromMongoUri(uri)).toBeUndefined();
  });
});
