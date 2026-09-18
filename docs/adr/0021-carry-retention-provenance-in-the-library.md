# Carry retention provenance in the portable Library

## Status

Accepted

## Context

ADR-0001 excluded observations from the portable Library because observations were then treated as current device filesystem state. SKIT now retains the exact acquired bytes. The observation of how those bytes entered the Library is historical evidence about retained content, while Projection paths, Ownership Markers, drift, and Custody remain current device facts.

Keeping Acquisition and observation evidence outside the portable document loses the only provenance for local adoptions and makes the same Library mean something different on each machine.

## Decision

The schema-v4 Library document is the single authoritative record of Collections, Skills, Skill Versions, Retained Trees, Acquisitions, global Bindings, Source Claims, and retention observations. This supersedes ADR-0001 only where it excludes observations.

An Acquisition records its machine, time, original input, source locator, selection, source revision, and observations. Historical absolute paths travel unchanged. They use `HistoricalPath` or `HistoricalLocator` wrapper values so code that accepts an actionable filesystem path or source string cannot consume them accidentally.

Derived content-addressed storage paths do not travel. A retained-object path is derived from the configured originals root and the Retained Tree digest.

An observation's bounded original third-party entry travels with its digest. URL credentials do not: serialization clears URL userinfo while preserving the historical host and locator.

Repository-scoped Bindings, Projections, Ownership Markers, Custody results, current unmanaged observations, drift, tombstones, and scan issues remain device state.

## Consequences

A shared Library can disclose historical machine identifiers, usernames, and project names contained in paths. This is an accepted property of portable provenance.

Historical locators cannot establish current reachability, desired state, authorship, or Custody. A workflow may explicitly revalidate one as current input: update resolves it and requires the resolved Collection identity to match; authored-workspace discovery requires a reachable real path and matching workspace metadata. Projection workflows never consume historical locators.

Schema v4 is corrected in place because the broken v4 was never published. Migration remains one hop from the restored schema-v3 state to corrected v4.
