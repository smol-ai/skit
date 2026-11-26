/** Local correction: only extraction configuration and file predicates from corpus.ts. */
export interface GraphConventions { readonly frameworks: ReadonlyArray<"opencode">; readonly packageBoundaries?: boolean }
export const NO_GRAPH_CONVENTIONS: GraphConventions = { frameworks: [] };
export const isCorpusFile = (path: string): boolean => /\.tsx?$/.test(path)
  && !/(^|\/)(?:node_modules|dist|build|generated|vendor|test|tests|fixtures)\/|\.d\.ts$|\.(?:test|spec)\.tsx?$/.test(path);
export const isGraphPackageManifest = (path: string): boolean => /(^|\/)package\.json$/.test(path)
  && !/(^|\/)(node_modules|dist|generated|vendor|test|tests|fixtures)\//.test(path);
