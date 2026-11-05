import { expect, test } from "vitest";
import { CurrentPrincipal, ConsumerAuthenticatedApi } from "@smolai/skit-core/api";
import {
  CurrentPrincipal as CompatibilityPrincipal,
  ConsumerAuthenticatedApi as CompatibilityConsumerApi,
} from "@smolai/skit-core/universal/api";

test("canonical and compatibility API imports resolve to the same module and identities", () => {
  expect(import.meta.resolve("@smolai/skit-core/api")).toBe(
    import.meta.resolve("@smolai/skit-core/universal/api"),
  );
  expect(CurrentPrincipal).toBe(CompatibilityPrincipal);
  expect(ConsumerAuthenticatedApi).toBe(CompatibilityConsumerApi);
});
