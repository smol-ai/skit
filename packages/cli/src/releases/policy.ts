import type { BuildInfo } from "@smolai/skit-core";

/** Entry-point policy: passive network access is only for interactive release runs. */
export function passiveCheckEnabled(
  build: BuildInfo,
  options: {
    readonly tty: boolean;
    readonly json: boolean;
    readonly ci: boolean;
    readonly disabled: boolean;
    readonly argv: readonly string[];
  },
): boolean {
  return (
    build.kind === "release" &&
    options.tty &&
    !options.json &&
    !options.ci &&
    !options.disabled &&
    !options.argv.some((arg) => ["version", "--version", "-v", "--help", "-h"].includes(arg))
  );
}
