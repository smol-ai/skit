import { Effect, FileSystem } from "effect";
import { isErrno } from "../platform/errno.js";
import { basename, dirname, join, resolve } from "node:path";
import { type HarnessName, type SkitBindingScope } from "@smolai/skit-core";
import { RoutesCollide } from "./failures.js";

/**
 * One Binding's declared writable destination. Scope and Harness are Binding intent; the
 * declared route is the directory the Harness profile resolves that intent to.
 */
export interface DeclaredRoute {
  harness: HarnessName;
  scope: SkitBindingScope;
  route: string;
}

export interface TargetCollision {
  destination: string;
  routes: readonly DeclaredRoute[];
}

export function scopeKey(scope: SkitBindingScope): string {
  return scope.kind === "global" ? "global" : `repository:${resolve(scope.root)}`;
}

export function routeKey(route: DeclaredRoute): string {
  return `${route.harness}|${scopeKey(route.scope)}`;
}

function scopeLabel(scope: SkitBindingScope): string {
  return scope.kind === "global" ? "global" : `repository ${resolve(scope.root)}`;
}

/** A path component that does not exist yet, which the walk climbs past. */
function isMissingComponent(error: unknown): boolean {
  return isErrno(error, "ENOENT", "ENOTDIR");
}

export function targetCollisionMessage(collisions: readonly TargetCollision[]): string {
  return collisions
    .map((collision) => {
      const routes = collision.routes
        .map((route) => `${route.harness} (${scopeLabel(route.scope)}) → ${route.route}`)
        .join("; ");
      return `${collision.destination} is selected by ${collision.routes.length} Bindings: ${routes}`;
    })
    .join("\n");
}

/** Fail before any filesystem or ledger mutation when distinct Bindings share a destination. */
/** Native route resolution retains fail-closed ancestor walking. */
export const physicalDestinationEffect = Effect.fn("Projection.physicalDestination")(function* (
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    const physical = yield* fs
      .realPath(current)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          isMissingComponent(error) ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
    if (physical !== undefined) return join(physical, ...missing);
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    missing.unshift(basename(current));
    current = parent;
  }
});
export const detectTargetCollisionsEffect = Effect.fn("Projection.detectTargetCollisions")(
  function* (routes: readonly DeclaredRoute[]) {
    const byDestination = new Map<string, Map<string, DeclaredRoute>>();
    for (const route of routes) {
      const destination = yield* physicalDestinationEffect(route.route);
      const group = byDestination.get(destination) ?? new Map<string, DeclaredRoute>();
      group.set(routeKey(route), route);
      byDestination.set(destination, group);
    }
    const collisions = [...byDestination]
      .filter(([, group]) => group.size > 1)
      .map(([destination, group]) => ({ destination, routes: [...group.values()] }));
    return collisions;
  },
);
export const assertNoTargetCollisionsEffect = Effect.fn("Projection.assertNoTargetCollisions")(
  function* (routes: readonly DeclaredRoute[]) {
    const collisions = yield* detectTargetCollisionsEffect(routes);
    if (collisions.length)
      return yield* new RoutesCollide({ detail: targetCollisionMessage(collisions) });
  },
);
