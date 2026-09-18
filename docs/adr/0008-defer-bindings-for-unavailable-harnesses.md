# Defer Bindings for unavailable Harnesses

SKIT treats a Binding as portable Library intent and Harness Availability as device-local evidence. Synchronizing a Binding onto a device where its Harness is unavailable retains the Binding unchanged but defers its Projection. Unavailability is not a Conflict, does not make the Library partially synchronized, and must not remove or rewrite portable intent.

This preserves the meaning of a Binding across heterogeneous devices. A Library Owner may want a Skill available to Codex and Claude Code even when one device has only Codex. That device must apply the Codex Projection without creating a speculative Claude Code directory, while another device with Claude Code continues to honor the same Library Manifest. If Claude Code later becomes available, an ordinary reconciliation can materialize the deferred Projection.

Harness Availability is determined locally from explicit configuration or evidence defined by the Harness Profile Catalog. It is not synchronized through the Library Manifest. Reconciliation output may report deferred Projections for unavailable Harnesses, but `partial` and `conflicted` remain reserved for requested filesystem effects that could not be completed safely.

We rejected pruning unavailable Harnesses from Bindings because that would turn one device's capabilities into everyone else's desired state. We rejected materializing into every known default root because an adapter being supported does not prove its Harness is installed, and creating unused configuration directories fabricates local state. We also rejected treating unavailability as a Conflict because there is no unsafe filesystem condition for the user to resolve.
