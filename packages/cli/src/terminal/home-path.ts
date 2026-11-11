import { sep } from "node:path";

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Show the home directory as `~` wherever it starts a path in human output, the way a person would
 * type it. Only a whole directory name matches: `/Users/tim/x` becomes `~/x`; `/Users/timothy` stays.
 * A colour code may follow the name directly.
 */
export const compactHome = (text: string, home: string): string =>
  home === "" || home === sep
    ? text
    : text.replace(
        new RegExp(`${escaped(home)}(?=$|[${escaped(sep)}/\\s'"\`),:;|\\]\\u001b])`, "g"),
        "~",
      );
