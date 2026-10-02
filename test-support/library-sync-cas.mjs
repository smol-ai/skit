// Shared HTTP stimuli and expectations. These sequential cases do not prove D1 atomicity.
export const librarySyncLabels = { changed: "test/changed", competing: "test/competing" };
export const librarySyncCasScenarios = [
  {
    id: "stale-base",
    uploadInitially: true,
    revisions: 2,
    steps: [
      {
        method: "PUT",
        path: "/api/library/portable",
        expectedRevision: "null",
        manifest: "initial",
        status: 200,
        capture: "base",
      },
      {
        method: "PUT",
        path: "/api/library/portable",
        expectedRevision: "base",
        manifest: "changed",
        status: 200,
        capture: "head",
      },
      {
        method: "PUT",
        path: "/api/library/portable",
        expectedRevision: "base",
        manifest: "competing",
        status: 409,
        body: {
          error: "REVISION_CONFLICT",
        },
        unchanged: true,
      },
    ],
  },
  {
    id: "retry-after-discarded-first-response",
    uploadInitially: true,
    revisions: 1,
    steps: [
      {
        method: "PUT",
        path: "/api/library/portable",
        expectedRevision: "null",
        manifest: "changed",
        status: 200,
        discard: true,
      },
      {
        method: "PUT",
        path: "/api/library/portable",
        expectedRevision: "null",
        manifest: "changed",
        status: 409,
        body: {
          error: "REVISION_CONFLICT",
        },
        unchanged: true,
      },
      {
        method: "GET",
        path: "/api/library/portable",
        status: 200,
        capture: "head",
        unchanged: true,
      },
      {
        method: "PUT",
        path: "/api/library/portable",
        expectedRevision: "head",
        manifest: "changed",
        status: 200,
        unchanged: true,
      },
    ],
  },
  {
    id: "retry-after-discarded-later-response",
    uploadInitially: true,
    revisions: 2,
    steps: [
      {
        method: "PUT",
        path: "/api/library/portable",
        expectedRevision: "null",
        manifest: "initial",
        status: 200,
        capture: "base",
      },
      {
        method: "PUT",
        path: "/api/library/portable",
        expectedRevision: "base",
        manifest: "changed",
        status: 200,
        discard: true,
      },
      {
        method: "PUT",
        path: "/api/library/portable",
        expectedRevision: "base",
        manifest: "changed",
        status: 409,
        body: {
          error: "REVISION_CONFLICT",
        },
        unchanged: true,
      },
      {
        method: "GET",
        path: "/api/library/portable",
        status: 200,
        capture: "head",
        unchanged: true,
      },
      {
        method: "PUT",
        path: "/api/library/portable",
        expectedRevision: "head",
        manifest: "changed",
        status: 200,
        unchanged: true,
      },
    ],
  },
  {
    id: "snapshot-readiness-and-reuse",
    uploadInitially: false,
    revisions: 1,
    steps: [
      {
        method: "PUT",
        path: "/api/library/portable",
        expectedRevision: "null",
        manifest: "initial",
        status: 400,
        body: {
          error: "invalid_request",
        },
        noRevision: true,
      },
      {
        method: "POST",
        path: "/api/library/snapshots",
        archive: true,
        status: 200,
        body: {
          reused: false,
        },
      },
      {
        method: "POST",
        path: "/api/library/snapshots",
        archive: true,
        status: 200,
        body: {
          reused: true,
        },
        unchanged: true,
      },
      {
        method: "PUT",
        path: "/api/library/portable",
        expectedRevision: "null",
        manifest: "initial",
        status: 200,
        capture: "head",
      },
    ],
  },
];
