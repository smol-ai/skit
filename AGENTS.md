# Validation

Run the smallest checks that cover the changed behavior.

- For CLI or TUI changes, run affected-package typechecks, focused tests, and relevant rendered UI or command smoke checks.
- Run server checks only when server code or shared core behavior changes in a way that affects the server.
- Run the full workspace suite (`pnpm check` or `pnpm check:ci`) only when the user explicitly requests it or CI requires it. A CI requirement does not require duplicating the full suite locally.
- Once relevant checks pass, do not broaden or repeat validation unless new changes, failures, or unresolved concerns justify it. Unrelated package checks are not a default final gate.
