import sections from "./sync-guarantees.json" with { type: "json" };

const guarantees = new Map(
  Object.entries(sections).flatMap(([section, titles]) =>
    Object.entries(titles).map(([key, title]) => [key, { section, title }]),
  ),
);

/** Use the calling package's Vitest instance to register the three real suites. */
export function syncGuarantee(describe, key, tests) {
  const { section, title } = guarantees.get(key);
  describe("skit sync", () => {
    describe(section, () => {
      describe(title, tests);
    });
  });
}
