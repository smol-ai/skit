import { isDeepStrictEqual } from "node:util";

/** Where a flow leaves an earlier one: it repeats that flow's first `at` frames, then differs. */
export interface Fork {
  readonly parent: number;
  readonly at: number;
}

const sharedPrefix = (a: readonly string[], b: readonly string[]) => {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length++;
  return length;
};

/**
 * Orders flows as a tree: each flow follows the earlier flow it shares the most leading frames
 * with. A shared prefix must contain at least one recorded frame. `parent` indexes the returned list.
 */
export function branchFlows<T>(
  flows: readonly T[],
  frames: (flow: T) => readonly string[],
  world?: (flow: T) => unknown,
): ReadonlyArray<{ readonly flow: T; readonly fork?: Fork }> {
  const keys = flows.map(frames);
  const worlds = flows.map((flow) => world?.(flow));
  // The earliest of the longest matches; it always draws the frame the fork leaves from.
  const forks = keys.map((own, index): Fork | undefined => {
    let best: Fork | undefined;
    for (let earlier = 0; earlier < index; earlier++) {
      if (!isDeepStrictEqual(worlds[index], worlds[earlier])) continue;
      const at = sharedPrefix(own, keys[earlier]!);
      if (at > 0 && at < own.length && at > (best?.at ?? 0)) best = { parent: earlier, at };
    }
    return best;
  });
  const order: number[] = [];
  const visit = (index: number) => {
    order.push(index);
    forks.forEach((fork, child) => {
      if (fork?.parent === index) visit(child);
    });
  };
  forks.forEach((fork, index) => {
    if (fork === undefined) visit(index);
  });
  return order.map((index) => {
    const fork = forks[index];
    return {
      flow: flows[index]!,
      ...(fork === undefined ? {} : { fork: { parent: order.indexOf(fork.parent), at: fork.at } }),
    };
  });
}
