import type { UsageRow } from "./contracts.js";
import type { UsageEvent } from "./events.js";

type Row = { -readonly [K in keyof UsageRow]: UsageRow[K] };
export interface InvocationObservation {
  key: string;
  row: Row;
  event: UsageEvent;
  session: string;
  turn?: string;
  timestamp: string;
}

/** Owns evidence correlation; renderers never reconstruct invocation counts. */
export function correlateInvocations(observations: readonly InvocationObservation[]): void {
  // Claude has native activation evidence; document access is diagnostic only.
  // Multi-skill commands are inspection evidence, not separate activations.
  const activity = observations.filter(
    (o) => o.event.kind !== "reads" || (o.row.harness === "codex" && !o.event.inspection),
  );
  const scope = (o: InvocationObservation) => JSON.stringify([o.row.harness, o.session]);
  const calls = new Map<string, InvocationObservation>();
  const linked = new Map<InvocationObservation, InvocationObservation>();
  for (const o of activity)
    if (o.event.kind === "calls" && o.event.id)
      calls.set(JSON.stringify([scope(o), o.event.id]), o);
  for (const o of activity) {
    if (!o.event.sourceToolUseId) continue;
    const call = calls.get(JSON.stringify([scope(o), o.event.sourceToolUseId]));
    if (call) linked.set(call, o);
  }

  // A name-only call or slash selection can share a path identity only when unique
  // in this turn. Two different paths with the same name remain separate.
  const callTurns = new Map<string, Map<string, InvocationObservation>>();
  const paths = new Map<string, Map<string, InvocationObservation>>();
  const nativePaths = new Map<string, Map<string, InvocationObservation>>();
  const namedTurn = (o: InvocationObservation) =>
    JSON.stringify([scope(o), o.turn, o.row.name.split(":").at(-1)]);
  for (const o of activity) {
    if (o.turn && o.event.kind === "calls") {
      const matches = callTurns.get(namedTurn(o)) ?? new Map();
      matches.set(o.key, o);
      callTurns.set(namedTurn(o), matches);
    }
    if (!o.turn || !o.row.path) continue;
    const matches = paths.get(namedTurn(o)) ?? new Map();
    matches.set(o.key, o);
    paths.set(namedTurn(o), matches);
    if (o.event.kind === "loads") {
      const nativeMatches = nativePaths.get(namedTurn(o)) ?? new Map();
      nativeMatches.set(o.key, o);
      nativePaths.set(namedTurn(o), nativeMatches);
    }
  }
  const representative = (o: InvocationObservation): InvocationObservation => {
    const load = linked.get(o);
    if (load) return load;
    if (!o.row.path && o.turn) {
      const matches = (o.event.kind === "selections" ? nativePaths : paths).get(namedTurn(o));
      if (matches?.size === 1) return matches.values().next().value ?? o;
      if (o.event.kind === "selections" && !matches?.size) {
        const calls = callTurns.get(namedTurn(o));
        if (calls?.size === 1) {
          const call = calls.values().next().value;
          if (call) return representative(call);
        }
      }
    }
    return o;
  };
  const groups = new Map<
    string,
    { row: Row; explicit: boolean; implicit: boolean; last: string }
  >();
  for (const o of activity) {
    const target = representative(o);
    // Slash commands include non-skill commands. Require corresponding native
    // skill activity before treating a command marker as a skill selection.
    if (o.event.kind === "selections" && target === o) continue;
    const call = o.event.sourceToolUseId
      ? calls.get(JSON.stringify([scope(o), o.event.sourceToolUseId]))
      : undefined;
    const turn = call?.turn ?? o.turn;
    // Without a turn, only an actual native link/ID can join observations.
    const unit = turn
      ? ["turn", turn]
      : ["event", o.event.sourceToolUseId ?? o.event.id ?? o.timestamp];
    const key = JSON.stringify([scope(o), unit, target.key]);
    const group = groups.get(key) ?? {
      row: target.row,
      explicit: false,
      implicit: false,
      last: o.timestamp,
    };
    group.explicit ||=
      o.event.kind === "selections" || (o.row.harness === "codex" && o.event.kind === "loads");
    group.implicit ||=
      o.row.harness === "claude-code"
        ? o.event.kind === "calls" || call !== undefined
        : o.event.kind === "reads" &&
          turn !== undefined &&
          (o.row.identity === "managed" || o.row.identity === "unmanaged");
    if (o.timestamp > group.last) group.last = o.timestamp;
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.row.uses++;
    group.row[group.explicit ? "explicit" : group.implicit ? "implicit" : "unknown"]++;
    if (group.last > group.row.lastObservedAt) group.row.lastObservedAt = group.last;
  }
}
