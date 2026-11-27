import { Effect, Option, Schema, pipe } from "effect";
import { Route, type Url } from "foldkit";
import type { IssuePlace } from "./atlas.ts";

/**
 * The Atlas's pages. Routes live in the URL's hash (`#/commands/author/sync`), so the built app
 * works from any static server at any path: the server only ever serves `index.html`.
 */
export const CommandTab = Schema.Literals([
  "invocation",
  "results",
  "states",
  "flows",
  "errors",
  "guarantees",
  "requirements",
]);
export type CommandTab = typeof CommandTab.Type;

export const AppRoute = Route.defineRouteUnion({
  Overview: {},
  Flows: {},
  Coverage: {},
  /** A command's words joined by slashes, such as `author/sync`. */
  Command: {
    path: Schema.String,
    test: Schema.optionalKey(Schema.String),
    tab: Schema.optionalKey(Schema.String),
  },
  /** A flow, opened at a step counted from 1 across the whole journey. */
  Flow: { flow: Schema.String, step: Schema.Int },
  Story: { key: Schema.String },
  Issues: {},
  Persistence: {},
  PersistedStore: { id: Schema.String },
  Services: {},
  Service: { id: Schema.String },
  Errors: {},
  Error: { path: Schema.String },
  Vocabulary: {},
  TerminalOutputVocabulary: {},
  NotFound: { path: Schema.String },
});
export type AppRoute = typeof AppRoute.Type;

/** A flow name, which can span segments, then its step; a bare flow name opens its first step. */
const flowStep: Route.Biparser<{ readonly flow: string; readonly step: number }> = {
  parse: (segments) => {
    const last = Number(segments.at(-1));
    const numbered = segments.length > 1 && Number.isInteger(last) && last >= 1;
    const flow = (numbered ? segments.slice(0, -1) : segments).join("/");
    if (flow === "")
      return Effect.fail(new Route.ParseError({ message: "Expected a flow name", position: 0 }));
    const parsed: Route.ParseResult<{ flow: string; step: number }> = [
      { flow, step: numbered ? last : 1 },
      [],
    ];
    return Effect.succeed(parsed);
  },
  print: ({ flow, step }, state) =>
    Effect.succeed({ ...state, segments: [...state.segments, ...flow.split("/"), String(step)] }),
};

const flowsRouter = pipe(Route.literal("flows"), Route.mapTo(AppRoute.Flows));
const coverageRouter = pipe(Route.literal("coverage"), Route.mapTo(AppRoute.Coverage));
const overviewRouter = pipe(Route.root, Route.mapTo(AppRoute.Overview));
// A named test stays addressable even when no saved report exists yet.
const commandTest: Route.Biparser<{ readonly path: string; readonly test?: string }> = {
  parse: (segments) => {
    const at = segments.indexOf("tests");
    if (at < 1 || at === segments.length - 1)
      return Effect.fail(
        new Route.ParseError({ message: "Expected a command and test name", position: 0 }),
      );
    const parsed: Route.ParseResult<{ path: string; test: string }> = [
      { path: segments.slice(0, at).join("/"), test: segments.slice(at + 1).join("/") },
      [],
    ];
    return Effect.succeed(parsed);
  },
  print: ({ path, test }, state) =>
    test === undefined
      ? Effect.fail(new Route.ParseError({ message: "Expected a test name", position: 0 }))
      : Effect.succeed({
          ...state,
          segments: [...state.segments, ...path.split("/"), "tests", ...test.split("/")],
        }),
};
const commandTestRouter = pipe(
  Route.literal("commands"),
  Route.slash(commandTest),
  Route.mapTo(AppRoute.Command),
);
// Like /tests/, /tabs/ is a reserved suffix, distinct from command words.
const commandTab: Route.Biparser<{ readonly path: string; readonly tab?: string }> = {
  parse: (segments) => {
    const at = segments.indexOf("tabs");
    if (at < 1 || at !== segments.length - 2)
      return Effect.fail(
        new Route.ParseError({ message: "Expected a command and tab name", position: 0 }),
      );
    const parsed: Route.ParseResult<{ path: string; tab: string }> = [
      { path: segments.slice(0, at).join("/"), tab: segments[at + 1]! },
      [],
    ];
    return Effect.succeed(parsed);
  },
  print: ({ path, tab }, state) =>
    tab === undefined
      ? Effect.fail(new Route.ParseError({ message: "Expected a tab name", position: 0 }))
      : Effect.succeed({
          ...state,
          segments: [...state.segments, ...path.split("/"), "tabs", tab],
        }),
};
const commandTabRouter = pipe(
  Route.literal("commands"),
  Route.slash(commandTab),
  Route.mapTo(AppRoute.Command),
);
const commandRouter = pipe(
  Route.literal("commands"),
  Route.slash(Route.restString("path")),
  Route.mapTo(AppRoute.Command),
);
const flowRouter = pipe(Route.literal("flows"), Route.slash(flowStep), Route.mapTo(AppRoute.Flow));
const storyRouter = pipe(
  Route.literal("stories"),
  Route.slash(Route.restString("key")),
  Route.mapTo(AppRoute.Story),
);
const persistenceRouter = pipe(Route.literal("data"), Route.mapTo(AppRoute.Persistence));
const storeRouter = pipe(
  Route.literal("data"),
  Route.slash(Route.string("id")),
  Route.mapTo(AppRoute.PersistedStore),
);
const servicesRouter = pipe(Route.literal("services"), Route.mapTo(AppRoute.Services));
const serviceRouter = pipe(
  Route.literal("services"),
  Route.slash(Route.restString("id")),
  Route.mapTo(AppRoute.Service),
);
const errorsRouter = pipe(Route.literal("errors"), Route.mapTo(AppRoute.Errors));
const errorRouter = pipe(
  Route.literal("errors"),
  Route.slash(Route.restString("path")),
  Route.mapTo(AppRoute.Error),
);
const issuesRouter = pipe(Route.literal("issues"), Route.mapTo(AppRoute.Issues));
const vocabularyRouter = pipe(Route.literal("vocabulary"), Route.mapTo(AppRoute.Vocabulary));
const terminalOutputVocabularyRouter = pipe(
  Route.literal("terminal-output-vocabulary"),
  Route.mapTo(AppRoute.TerminalOutputVocabulary),
);

const parseRoute = Route.parseUrlWithFallback(
  Route.oneOf(
    storeRouter,
    persistenceRouter,
    commandTestRouter,
    commandTabRouter,
    commandRouter,
    flowRouter,
    flowsRouter,
    coverageRouter,
    storyRouter,
    errorRouter,
    errorsRouter,
    serviceRouter,
    servicesRouter,
    issuesRouter,
    vocabularyRouter,
    terminalOutputVocabularyRouter,
    overviewRouter,
  ),
  AppRoute.NotFound,
);

/** The page a URL's hash names. */
export const routeOf = (url: Url.Url): AppRoute =>
  parseRoute({ ...url, pathname: Option.getOrElse(url.hash, () => "/") });

export const flowsHref = `#${flowsRouter()}`;
export const coverageHref = `#${coverageRouter()}`;
export const overviewHref = `#${overviewRouter()}`;
export const persistenceHref = `#${persistenceRouter()}`;
export const storeHref = (id: string) => `#${storeRouter({ id })}`;
export const servicesHref = `#${servicesRouter()}`;
export const serviceHref = (id: string) => `#${serviceRouter({ id })}`;
export const errorsHref = `#${errorsRouter()}`;
export const errorHref = (path: string) => `#${errorRouter({ path })}`;
export const issuesHref = `#${issuesRouter()}`;
export const vocabularyHref = `#${vocabularyRouter()}`;
export const terminalOutputVocabularyHref = `#${terminalOutputVocabularyRouter()}`;
/** The page of a command as typed after `skit`, such as `author sync`. */
export const commandHref = (command: string) =>
  `#${commandRouter({ path: command.replaceAll(" ", "/") })}`;
export const commandTabHref = (command: string, tab: CommandTab) =>
  `#${commandTabRouter({ path: command.replaceAll(" ", "/"), tab })}`;
export const testHref = (command: string, test: string) =>
  `#${commandTestRouter({ path: command.replaceAll(" ", "/"), test })}`;
export const flowHref = (flow: string, step: number) => `#${flowRouter({ flow, step })}`;
export const storyHref = (key: string) => `#${storyRouter({ key })}`;

/** The page that shows a copy issue: its flow step, or its story. */
export const placeHref = (place: IssuePlace) =>
  place.kind === "step" ? flowHref(place.flow, place.step) : storyHref(place.key);
