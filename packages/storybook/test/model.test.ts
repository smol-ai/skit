import { describe, expect, it } from "vitest";
import { catalog, filterCatalog, renderOutput } from "../src/model";

describe("storybook browser model", () => {
  it("indexes both catalogs and filters by path", () => {
    expect(catalog.some(({ kind }) => kind === "output")).toBe(true);
    expect(catalog.some(({ kind }) => kind === "journey")).toBe(true);
    expect(filterCatalog("library-sync/merged").map(({ key }) => key)).toEqual([
      "library-sync/merged",
    ]);
    for (const kind of ["output", "journey"] as const) {
      const keys = catalog.filter((item) => item.kind === kind).map(({ key }) => key);
      expect(keys).toEqual([...keys].sort((left, right) => left.localeCompare(right)));
    }
  });

  it("renders a selected output", () => {
    const item = catalog.find(({ key }) => key === "library-sync/merged");
    expect(item?.kind).toBe("output");
    if (item?.kind !== "output") return;
    const rendered = renderOutput(item.index, {
      color: false,
      detail: "summary",
      format: "human",
    });
    expect(rendered).toBeTruthy();
    expect(rendered).not.toContain("STDOUT");
  });
});
