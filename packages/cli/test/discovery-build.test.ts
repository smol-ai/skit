import { expect, it } from "vitest";
import { Schema } from "effect";
import { serverDiscoverySchema } from "@smolai/skit-core";
it("keeps future diagnostic build metadata from breaking server discovery", () => {
  const discovery = {
    schema: "skit.server.v1",
    download: "/download",
    scopes: [],
    build: { kind: "future", version: "1.0.0", newField: true },
    future: true,
  };
  expect(Schema.decodeUnknownSync(serverDiscoverySchema)(discovery).build).toEqual(discovery.build);
});
