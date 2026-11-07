import { homedir } from "node:os";
import { sep } from "node:path";

/** Show a path under the home directory as `~/…`, the way a person would type it. */
export const compactHomePath = (path: string, home: string = homedir()): string =>
  path === home ? "~" : path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
