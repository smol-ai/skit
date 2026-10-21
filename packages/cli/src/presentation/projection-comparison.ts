import { shellQuote } from "./shell-quote.js";

/** The comparison's surrounding notes; Git owns the directory diff and pager. */
export const projectionComparisonNotes = (query: string, selector: string) => {
  const command = `skit update ${shellQuote(query)} --from-projection ${shellQuote(selector)}`;
  return {
    introduction: {
      title: "Compare copies",
      body: "Library source is on the left; the installed copy is on the right. Agent-generated files and metadata can differ. Press q to exit the pager. No changes will be applied.",
    },
    completion: {
      title: "Comparison complete",
      body: `No files were changed.\n\nKeep the installed copy: ${command} --dry-run\nUse the Library version: ${command} --use-library --dry-run`,
    },
  };
};
