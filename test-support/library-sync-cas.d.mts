export const librarySyncLabels: { readonly changed: string; readonly competing: string };
export const librarySyncCasScenarios: readonly {
  readonly id: string;
  readonly uploadInitially: boolean;
  readonly revisions: number;
  readonly steps: readonly {
    readonly method: "GET" | "PUT" | "POST";
    readonly path: string;
    readonly expectedRevision?: "null" | "base" | "head";
    readonly manifest?: "initial" | "changed" | "competing";
    readonly archive?: boolean;
    readonly status: number;
    readonly capture?: "base" | "head";
    readonly body?: Readonly<Record<string, string | boolean>>;
    readonly unchanged?: boolean;
    readonly discard?: boolean;
    readonly noRevision?: boolean;
  }[];
}[];
