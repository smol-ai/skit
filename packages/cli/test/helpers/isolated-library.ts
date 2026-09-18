export interface IsolatedRoots {
  home: string;
  codexRoot: string;
  claudeRoot: string;
  opencodeRoot: string;
  devinRoots: string[];
}

/**
 * Every writable Harness root under one temporary directory. A root left unset falls back to
 * this machine's real Harness directory, so a Projection for an unset Harness would escape the
 * test and mutate the operator's own Library. Isolate all of them, not only the ones a test
 * expects to exercise.
 */
export function isolatedRoots(root: string): IsolatedRoots {
  return {
    home: `${root}/home`,
    codexRoot: `${root}/codex`,
    claudeRoot: `${root}/claude`,
    opencodeRoot: `${root}/opencode`,
    devinRoots: [`${root}/devin`],
  };
}
