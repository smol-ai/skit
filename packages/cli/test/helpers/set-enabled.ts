import { Effect } from "effect";
import type { InstallScope } from "@smolai/skit-core/library";
import type { InvocationOption } from "@smolai/skit-core/library/session";
import * as Library from "@smolai/skit-core/library";
import type { SetEnabledIntent } from "@smolai/skit-core/library/enable";
type ManageApproval = NonNullable<SetEnabledIntent["manage"]>;
import { withLibraryOwner } from "./library-owner.js";
import { setEnabledOutcomes } from "@smolai/skit-core/library/enable";
export { SetEnabledIncomplete, setEnabledOutcomes } from "@smolai/skit-core/library/enable";
import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";

export interface SetEnabledRequest {
  readonly query: string;
  readonly all?: boolean;
  readonly selectedSkills?: readonly string[];
  readonly scope: InstallScope;
  readonly enabled: boolean;
  readonly invocation?: InvocationOption;
  readonly allowDuplicate?: boolean;
  /** Setup consent applies only to these exact symlinks, until installing succeeds. */
  readonly allowedDuplicateSymlinks?: readonly {
    readonly path: string;
    readonly canonicalPath: string;
    readonly dev: bigint;
    readonly ino: bigint;
    readonly linkTarget?: string;
  }[];
  readonly manage?: ManageApproval;
}

/** User intent, independent of the per-Scope requests needed to implement it. */
/** One request in front-end terms: its subject is text, resolved against the Library planned. */
export const toEnabledIntent = (request: SetEnabledRequest): SetEnabledIntent => ({
  subject: request.query,
  enabled: request.enabled,
  ...(request.all
    ? { members: "whole" as const }
    : request.selectedSkills === undefined
      ? {}
      : { members: request.selectedSkills }),
  where: [request.scope],
  ...(request.invocation === undefined ? {} : { invocation: request.invocation }),
  ...(request.allowDuplicate === undefined ? {} : { allowDuplicate: request.allowDuplicate }),
  ...(request.manage === undefined ? {} : { manage: request.manage }),
  ...(request.allowedDuplicateSymlinks !== undefined
    ? {
        setup: {
          approvedSymlinks: (request.allowedDuplicateSymlinks ?? []).map((link) => ({
            path: link.path,
            canonicalPath: link.canonicalPath,
            dev: String(link.dev),
            ino: String(link.ino),
            ...(link.linkTarget === undefined ? {} : { linkTarget: link.linkTarget }),
          })),
        },
      }
    : {}),
});

interface SetEnabledOptions {
  readonly query: string;
  readonly all: boolean;
  readonly selectedSkills?: readonly string[];
  readonly allowDuplicate?: boolean;
  readonly allowedDuplicateSymlinks?: SetEnabledRequest["allowedDuplicateSymlinks"];
  readonly manage?: SetEnabledRequest["manage"];
  readonly roots: InventoryRootOptions;
  readonly variantsPath: string;
  readonly invocation: {
    readonly scope: InstallScope;
    readonly enabled: boolean;
    readonly invocation?: InvocationOption;
    readonly dryRun: boolean;
  };
}

/** Test convenience for one request; all planning and execution use the public application seam. */
const requestFor = (options: SetEnabledOptions): SetEnabledRequest => ({
  query: options.query,
  all: options.all,
  selectedSkills: options.selectedSkills,
  allowDuplicate: options.allowDuplicate,
  allowedDuplicateSymlinks: options.allowedDuplicateSymlinks,
  manage: options.manage,
  scope: options.invocation.scope,
  enabled: options.invocation.enabled,
  invocation: options.invocation.invocation,
});

export const planLibraryEnabled = (options: SetEnabledOptions) => {
  return Effect.gen(function* () {
    const library = yield* Library.Service;
    return yield* library.planEnabled([toEnabledIntent(requestFor(options))], {
      base: yield* library.read,
    });
  }).pipe(withLibraryOwner(options.roots));
};

export const setLibraryEnabled = Effect.fn("Test.setLibraryEnabled")(
  function* (options: SetEnabledOptions) {
    const library = yield* Library.Service;
    const plan = yield* library.planEnabled([toEnabledIntent(requestFor(options))], {
      base: yield* library.read,
    });
    if (options.invocation.dryRun) {
      const value = plan.changes[0];
      if (value === undefined) return yield* Effect.die("Expected one plan");
      return { kind: "plan" as const, value };
    }
    const [outcome] = yield* setEnabledOutcomes(
      (yield* library.apply({ _tag: "Apply", plan: plan.plan })).result,
    );
    if (outcome === undefined) return yield* Effect.die("Expected one outcome");
    return outcome;
  },
  (effect, options) => effect.pipe(withLibraryOwner(options.roots)),
);
