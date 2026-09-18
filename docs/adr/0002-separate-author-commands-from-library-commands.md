# Separate Author commands from Library commands

> Partially superseded by ADR-0004: Author synchronization is now ordinary Git rather than `skit author sync`.

SKIT places operations performed in the Author role under `skit author` and keeps Library management and skill consumption at the top level. This makes `skit author sync` unambiguously synchronize authored content with a remote Draft, while top-level `skit sync` restores portable Library intent between machines. We rejected both a flat command tree, which overloaded `sync`, and noun-scoping every context, which made the common consuming journey expose unnecessary domain structure.

The move intentionally makes the former top-level `init`, `validate`, and `publish` spellings hard errors. Because the former top-level `sync` also accepted no path and `--apply`, the new Library operation refuses to run from an authored SKIT directory and directs the Author to `skit author sync`; this prevents a previously valid mutating command from silently changing targets.
