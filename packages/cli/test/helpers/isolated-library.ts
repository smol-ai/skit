export interface IsolatedRoots {
  home: string;
  codexRoot: string;
  claudeRoot: string;
  opencodeRoot: string;
  devinRoots: string[];
}

/**
 * Every writable skills directory under one temporary directory. A root left unset falls back to
 * this machine's real Harness directory, so an installed skill for an unset Harness would escape the
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
