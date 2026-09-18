# Materialize independent writable Projections

SKIT materializes each enabled Skill as an independent directory at each Projection Target rather than symlinking every Harness to one canonical copy. The Author working tree, retained immutable artifact, and writable Projections must remain separate: a Harness-side edit may create drift in one Projection, but must not mutate authored or retained content or silently affect another Harness.

We rejected the shared-directory symlink model used by skills.sh because one mutation would be visible through every symlink, one shared directory could not carry a distinct Ownership Marker for each Projection, and collection-level shared files must be assembled into each projected Skill. Copies cost additional disk space, but preserve per-Projection Custody, drift detection, transactional replacement, and safe removal. A future implementation may deduplicate storage below the filesystem interface only if these semantics remain unchanged.
