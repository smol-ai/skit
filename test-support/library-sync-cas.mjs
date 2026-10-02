// Both the real Worker and the client fake must obey these public CAS outcomes.
export const librarySyncCasScenarios = [
  {
    id: "first-owner-race",
    base: "absent",
    operation: "race",
    statuses: [200, 409],
    conflict: { error: "REVISION_CONFLICT" },
  },
  {
    id: "empty-head-race",
    base: "empty",
    operation: "race",
    statuses: [200, 409],
    conflict: { error: "REVISION_CONFLICT" },
  },
  {
    id: "existing-head-race",
    base: "existing",
    operation: "race",
    statuses: [200, 409],
    conflict: { error: "REVISION_CONFLICT" },
  },
  {
    id: "stale-base",
    base: "existing",
    operation: "stale",
    statuses: [409],
    conflict: { error: "REVISION_CONFLICT" },
  },
  {
    id: "lost-first-response",
    base: "empty",
    operation: "retry",
    statuses: [409, 200],
    conflict: { error: "REVISION_CONFLICT" },
  },
  {
    id: "lost-later-response",
    base: "existing",
    operation: "retry",
    statuses: [409, 200],
    conflict: { error: "REVISION_CONFLICT" },
  },
];
