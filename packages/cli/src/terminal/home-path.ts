import { sep } from "node:path";

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Show the home directory as `~` wherever it starts a path in human output, the way a person would
 * type it. Only a whole directory name matches: `/Users/tim/x` becomes `~/x`; `/Users/timothy` stays.
 * A colour code may follow the name directly.
 */
export const compactHome = (text: string, home: string): string => {
  if (home === "" || home === sep) return text;
  // macOS resolves the /var symlink when it returns a canonical workspace path.
  const prefix = home.startsWith("/var/") ? `(?:/private)?${escaped(home)}` : escaped(home);
  return text.replace(
    new RegExp(
      `(^|[\\s'"\`(:,;|\\[=]|\\u001b\\[[0-9;]*m)${prefix}(?=$|[${escaped(sep)}/\\s'"\`),:;|\\]\\u001b])`,
      "g",
    ),
    "$1~",
  );
};
