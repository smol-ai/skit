// A finite handoff to Tart, whose VM must outlive the invoking CLI's Effect scope.
// All other command processes are scoped through Processes. No guest data is handled here.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
const [tart, log, name] = process.argv.slice(2);
const fd = openSync(log, "a", 0o600);
const child = spawn(tart, ["run", "--no-graphics", "--no-clipboard", "--no-audio", name], {
  detached: true,
  stdio: ["ignore", fd, fd],
});
child.once("error", () => {
  closeSync(fd);
  console.error("Could not launch Tart.");
  process.exitCode = 1;
});
child.once("spawn", () => {
  closeSync(fd);
  console.log(child.pid);
  child.unref();
});
