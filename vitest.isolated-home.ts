// Every test file runs against a throwaway HOME. Skill projection writes to roots derived from
// HOME (for example `~/.claude/skills` once Claude Code is detected), so a test that forgets an
// override must never reach the developer's real Skill roots. Child processes inherit this env.
// The directory need not exist: whatever a test writes beneath it is created on demand.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = join(tmpdir(), `skit-test-home-${randomUUID()}`);
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
delete process.env.CODEX_HOME;
delete process.env.SKIT_HOME;

process.env.XDG_STATE_HOME = join(home, ".local", "state");
process.env.SKIT_NPM_REGISTRY = "http://127.0.0.1:1";
