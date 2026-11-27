import "vitest";
import sync from "./fixtures/sync-guarantees.json" with { type: "json" };

declare module "vitest" {
  interface TaskMeta {
    guarantee?: (typeof sync)[keyof typeof sync];
  }
}
