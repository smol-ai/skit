# Linux VM testing

Use `pnpm vm` to try SKIT in a disposable Linux home with interactive Codex.
Each trial gets its own checkout, Library, agent skills, and credentials.
The host must be an Apple Silicon Mac running macOS 14 or newer, with Node and
pnpm installed as described in [Development](./development.md).

## First use

From the checkout root:

```sh
pnpm vm install-tart
pnpm vm baseline
pnpm vm new skit-first-run
pnpm vm auth-copy skit-first-run
pnpm vm codex skit-first-run
```

`baseline` downloads a pinned Debian ARM64 image, installs Node, pnpm, and Codex,
then shuts the VM down. It is idempotent. It never authenticates or runs SKIT.
`new` clones that stopped baseline, boots it in the background, waits for its
agent, copies the checkout, builds core and CLI, and links `skit` in the guest.
Boots and builds can take several minutes; commands print progress and exit on
failure. No second terminal or manual boot wait is needed.

`auth-copy` reuses your host's existing file-based Codex sign-in. It reads
`${CODEX_HOME:-~/.codex}/auth.json` directly into memory and sends it to that
trial over the guest agent's stdin. It atomically replaces the guest auth cache
with file permissions `0600` in a directory with permissions `0700`, then checks
`codex login status`. Credentials are never printed or written into host logs or
temporary files. The baseline refuses this command. The copied cache remains in
that trial until removed; deleting the trial removes its copy. Token refreshes
inside a trial are not synchronized back to the host. Concurrent refresh behavior
across host and guest has not been tested; a copied sign-in may need replacing if
refresh fails. Use a separate device login when independent sessions are needed.

If your host uses keychain-only storage or has no reusable cache, run
`pnpm vm login skit-first-run` instead. Device login prints a link and code to
approve in your usual browser. Your
ChatGPT account or workspace must permit device-code login. Credentials stay in
that trial and are not written into the baseline. Login, auth-copy, and Codex
commands refuse to target `skit-base`.

On first use, Codex asks whether to trust the guest checkout. Its normal sandbox
may also ask permission for SKIT writes under `~/.skit` and `~/.agents`, outside
the checkout. Approve only the guest operations you intend to test.

In Codex, ask it to help you try `skit setup`. To use SKIT yourself:

```sh
pnpm vm shell skit-first-run
# In the guest:
cd ~/skit
skit setup
```

An empty home has no skills to discover. Install the desired harness or create
representative skills under the guest's `~/.agents/skills` to test discovery and
adoption. Normal `~/.skit`, `~/.agents`, and `~/.claude` paths belong to the guest;
no path overrides are needed.

## Repeat and recover

### Swyx's source skills

Create a fresh trial with real source skills and Codex symlinks:

```sh
pnpm vm new skit-swyx --fixture swyx
pnpm vm shell skit-swyx
# In the guest:
cd ~/Work/skills
skit setup
```

The fixture clones `swyxio/skills` at
`7a57f05a9137c00cd75b81b1991c16dc800ef5fe` (September 30, 2026) into
`~/Work/skills`, with 98 absolute directory symlinks under `~/.codex/skills`.
The repository remains a real Git checkout. Shell and Codex sessions open in
`~/Work/skills`, as recorded by the fixture marker's `cwd`. It does not run upstream scripts,
apply SKIT setup, or copy credentials. For interactive Codex, run
`pnpm vm auth-copy skit-swyx` followed by `pnpm vm codex skit-swyx`.

This reconstructs the reported pre-SKIT source-and-symlink layout, rather
than restoring all the old dump's Library state, other agent folders, or third
party skills. The 98 names match the source skills in the old `skit.setup.v4`
dump; 96 of their normalized tree hashes match. `video-talk-to-essay` and
`youtube-api` differ; their original bytes cannot be recovered from the dump.
The Codex link layout comes from the reported layout: the dump does not preserve
the original link targets. Guest paths use the guest's home, not `/Users/swyx`.
The fixture revision is also recorded in `~/.skit-vm-fixture.json`.
Checked with guest Codex 0.165.0 using its local `skills/list` app-server method:
all 98 source skills load with user scope and no errors. Codex resolves the
legacy `~/.codex/skills` symlinks to their source paths and leaves the links in
place. This check required neither credentials nor a model call.
The trial also contains the development checkout at `~/skit` and an npm-linked
SKIT build from it; these are test tooling rather than a reconstruction of the
original machine. They remain accessible but are outside the session's working
directory.

### Manage trials

```sh
pnpm vm new                  # creates and prints a unique trial name
pnpm vm list
pnpm vm stop skit-first-run   # preserves the disk; shell/login/codex restart it
pnpm vm rm skit-first-run     # stops and deletes that trial, including its login
```

Startup releases its per-VM lock before attaching an interactive shell or Codex.
You can open another shell to inspect the same trial or create a different trial
while Codex is running. `stop` and `rm` may terminate active sessions.

Mutation locks are published atomically and released by Effect scopes on failure
or interruption. Locks left by a killed host process fail closed: inspect the
owner in `<state>/locks/<name>.lock` and remove the file only after confirming
that process has stopped. For a same-host owner that is confirmed gone, the error
prints an exact, shell-quoted removal command; recheck the recorded owner before
running it. Locks are never reclaimed automatically. Terminal hangup is routed
through Effect interruption so normal finalizers can run.

A failed build or transfer preserves the trial. Inspect its boot log in
`<state>/logs/<name>.log`. Interruption cancels an owned guest job's process group;
its guest-side deadline also limits work if the host dies abruptly. A job with
uncertain ownership blocks another job rather than risking concurrent builds.
Stop the VM, then retry; startup creates a new boot identity. Job tickets are
namespaced by Linux boot ID, and launch/cancellation calls verify that identity
before reading or signalling any recorded process group. Earlier-boot tickets
are ignored, so PID reuse after reboot cannot grant cancellation authority.

- If copying succeeded but installation or compilation failed, use
  `pnpm vm build <name>` to retry in that checkout.
- A failed archive extraction remains at `~/skit.partial` and is never published
  as `~/skit`. Discard that trial with `pnpm vm rm <name>` and create another.
- If preparation fails, fix the cause and rerun `pnpm vm baseline`.
- A changed version pin or guest preparation script makes the baseline stale.
  `pnpm vm reset` rebuilds it and preserves existing trials.
- A running baseline is refused for cloning. Use `pnpm vm stop skit-base` first.
- Baseline deletion requires `pnpm vm rm skit-base --baseline`. Neither deletion
  nor reset changes existing trial disks.

A trial copies the current bytes of tracked and untracked files visible to Git,
including local edits and excluding deleted tracked paths. Git-ignored files,
host Git metadata, dependencies, and build output are excluded. Review
`git status --short` before creating a trial: non-ignored personal files in the
checkout are included. New files need not be staged. Changes made inside the
trial stay there; create another trial to copy later host edits.

## State, versions, and boundaries

Default state lives outside the checkout at:

```text
~/Library/Application Support/skit-dev/tart/
  tool/          pinned standalone Tart and its licence
  vms/           cached Debian image and VM disks
  logs/          boot logs
  baseline.json  preparation fingerprint and installed tool versions
```

Deleting or cleaning the checkout does not delete VMs. Set `SKIT_VM_HOME` to an
absolute directory to keep an independent set of machines elsewhere. The helper
disables Tart automatic pruning. It does not garbage-collect trial disks for you.
VM disks retain guest credentials until you delete them; the state directory is
kept at private `0700` permissions, including pre-existing state directories.

Pins for Tart, the Debian image digest, Node's archive and SHA-256, and pnpm live
in `packages/devtools/src/configuration.ts`. `install-tart` checks a pinned archive SHA-256 before
extracting it. Run installation as maintenance, with other VM commands idle.
`TART_BIN` can select an absolute path to the same Tart version.
The standalone distribution avoids the Homebrew formula's Softnet dependency,
which currently requires Tahoe.

Codex defaults to the current npm version when preparing the baseline, then stays
at that version across clones. The actual installed version is recorded in
`baseline.json`. Set `CODEX_VERSION=<version>` when preparing or resetting a
baseline to pin it. Ordinary trial commands use the recorded baseline and do not
require that environment variable. Run `pnpm vm reset` to update a baseline that
uses `latest`. Guest preparation writes a fingerprint checked in each clone;
a host record is published only after the baseline shuts down successfully.

The helper exposes no shared folders, clipboard, or audio to the guest. The host
Codex auth cache is transferred only by an explicit `auth-copy` command. Default NAT
allows internet and host/LAN access: this is filesystem
isolation, not network isolation. It uses Tart's guest agent instead of SSH keys
or passwords. This exercises Linux onboarding; macOS keychain and macOS-specific
harness behavior need a separate macOS test.

The pinned [Tart FSL-1.1-ALv2 licence](https://github.com/openai/tart/blob/2.41.1/LICENSE)
explicitly permits internal use. This helper downloads the upstream distribution
for contributor use and retains its licence; it does not ship Tart in SKIT's CLI.

## Footprint and verification

Trials use two CPUs and 2 GB RAM with a 20 GB virtual disk. The Debian image is
about 600 MB compressed; its fresh filesystem uses about 819 MB. Prepared tools
bring guest usage to about 2 GB before the checkout and dependencies. Host disk
allocation includes the cached image and changes written to each clone.

Earlier testing confirmed that 1 GB RAM renders Codex's login screen but runs out of
memory compiling this checkout (`tsc` was killed by the kernel). Core/CLI builds,
CLI help, JSON inventory, and interactive fresh setup passed at 2 GB in the
initial implementation. The
supported starting allocation is therefore 2 GB.

Auth-cache reuse was verified in a test trial: its copy matched the host source,
the directory and file modes were `0700`/`0600`, Codex recognized the ChatGPT
login, and a model-backed request returned the expected response. Missing and
malformed cache checks fail without printing credential contents; baseline
targets are refused.

Sources: [Tart quick start](https://tart.run/quick-start/),
[Tart interactive exec](https://github.com/openai/tart/blob/2.41.1/Sources/tart/Commands/Exec.swift),
[Debian image templates](https://github.com/cirruslabs/linux-image-templates),
[Codex authentication](https://learn.chatgpt.com/docs/auth).

## Implementation and checks

`pnpm vm` runs the private `@smolai/skit-devtools` TypeScript package directly with
Node's type stripping. It does not require building SKIT before creating a trial.

```text
Effect CLI
└─ VM workflows: baseline, trial creation, auth, and mutation lock scopes
   ├─ state: atomic publication and cross-process ownership
   ├─ Tart: readiness, shutdown, and guest process-group cancellation
   └─ processes: scoped host subprocesses, streams, and redacted failures
```

Interactive attachments start after releasing their startup lock. A small Node
launcher hands a detached VM process to Tart so it survives the invoking CLI;
other command processes use Effect's scoped spawner. Temporary host files and
locks have scope-owned cleanup. Guest mutations run in owned process groups with
Linux `timeout`; interruption sends TERM/KILL through a separate guest call.
Before user code runs, the guest verifies the process-group leader reported by
the child. Cancellation tickets cover jobs interrupted before their process id
is published. Ordinary failed jobs leave no ticket behind; a pre-launch ticket
is retained until an undelivered launcher can acknowledge its cancellation.

Run focused checks with:

```sh
pnpm --filter @smolai/skit-devtools typecheck
pnpm --filter @smolai/skit-devtools test
```

The default tests use temporary host files and processes, plus controlled Effect
services and `TestClock`; they need neither Tart nor account access. To verify
real guest cancellation using an existing trial, opt in explicitly:

```sh
SKIT_VM_TEST_NAME=skit-first-run pnpm --filter @smolai/skit-devtools exec vitest run test/tart-live.test.ts
```

Those checks use only temporary guest jobs and fixtures: cancel before and after
launch, reject a forking launcher whose group differs, confirm a normal nonzero
exit leaves no new cancellation ticket, and recover from uncertain ownership
after a real VM stop/start. The launcher fixture is restored
on exit. They make no model requests. The host suite also kills a lock owner with
SIGKILL and verifies the stale-lock guidance without deleting the lock.

The Effect workflow was verified on October 30, 2026: reset the clean baseline,
create/build a fresh trial, copy auth, open interactive Codex, and have it review
and apply setup for one guest-only skill. An independent inventory query confirmed
the fixture was SKIT-owned and in the Library. Setup and inventory used normal
Codex permission prompts. A second shell opened concurrently; exiting it with
status 7 propagated status 7. Transfer assertions covered an untracked file, a
broken symlink, and an absent tracked file. Injecting failure after extraction
left only `~/skit.partial`, with no published checkout.
