import { commandGuarantees } from "./pages/guarantees.ts";
import { Effect, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  AsyncData,
  Command,
  Navigation,
  Subscription,
  Url,
  type Runtime,
  type Update,
} from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { Atlas, Frame } from "../../src/atlas/data.ts";
import { commandGroups, errorExamples, copyIssues, framePath, flowPath, plural } from "./atlas.ts";
import * as Accordion from "./fluid/components/accordion";
import * as Breadcrumb from "./fluid/components/breadcrumb";
import * as CommandMenu from "./fluid/components/command-menu";
import * as CommandDialog from "./fluid/components/command-menu/dialog";
import * as Dialog from "./fluid/components/dialog";
import { icon } from "./fluid/components/icons";
import * as Sidebar from "./fluid/components/sidebar";
import * as Switch from "./fluid/components/switch";
import * as Tabs from "./fluid/components/tabs";
import * as Tooltip from "./fluid/components/tooltip";
import { AtlasData, FrameData, Message, type Model, tipOf } from "./model.ts";
import { frame as frameView } from "./parts.ts";
import { commandPage, commandTabFor, commandResultsLabel } from "./pages/command.ts";
import { coveragePage } from "./pages/coverage.ts";
import { flowPage } from "./pages/flow.ts";
import { flowsPage } from "./pages/flows.ts";
import { overview } from "./pages/overview.ts";
import {
  issuesPage,
  notFoundPage,
  vocabularyPage,
  terminalOutputVocabularyPage,
  terminalOutputVocabularyTitle,
} from "./pages/reference.ts";
import { errorDisclosures, errorKey, errorPage, errorsPage } from "./pages/errors.ts";
import { storeDisclosures, persistencePage, persistedStorePage } from "./pages/persistence.ts";
import {
  servicesPage,
  servicePage,
  serviceName,
  mapDisclosures,
  localServices,
} from "./pages/services.ts";
import { storyPage } from "./pages/story.ts";
import {
  type AppRoute,
  commandHref,
  commandTabHref,
  CommandTab,
  flowHref,
  issuesHref,
  errorsHref,
  servicesHref,
  serviceHref,
  persistenceHref,
  storeHref,
  errorHref,
  overviewHref,
  flowsHref,
  coverageHref,
  placeHref,
  routeOf,
  storyHref,
  vocabularyHref,
  terminalOutputVocabularyHref,
} from "./route.ts";

/** Navigation opens the selected test's guarantee; subsequent expansion belongs to Accordion. */
const initialGuarantees = (atlas: Atlas, route: AppRoute): Accordion.Model => ({
  expanded:
    route._tag === "Command" && route.test !== undefined
      ? commandGuarantees(atlas, route.path.replaceAll("/", " "))
          .filter((group) => group.tests.some(({ test }) => test.title === route.test))
          .map((group) => group.key)
      : [],
});

const LoadAtlas = Command.define("LoadAtlas", {
  messages: [Message.LoadedAtlas, Message.FailedToLoadAtlas],
  execute: HttpClient.get("atlas.json").pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Atlas)),
    Effect.map((atlas) => Message.LoadedAtlas({ atlas })),
    Effect.catch((error) => Effect.succeed(Message.FailedToLoadAtlas({ reason: error.message }))),
  ),
});

export const LoadFrame = Command.define("LoadFrame", {
  args: { path: Schema.String },
  messages: [Message.LoadedFrame, Message.FailedToLoadFrame],
  execute: ({ path }) =>
    HttpClient.get(path).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Frame)),
      Effect.map((frame) => Message.LoadedFrame({ path, frame })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedToLoadFrame({ path, reason: error.message })),
      ),
    ),
});

/** The frames a page shows; a flow's neighbouring steps too, so stepping draws at once. */
export function framesOn(atlas: Atlas, route: AppRoute): readonly string[] {
  switch (route._tag) {
    case "Command": {
      const command = atlas.commands.find(
        (entry) => entry.command === route.path.replaceAll("/", " "),
      );
      if (command === undefined) return [];
      const keys = new Set([
        ...command.stories,
        ...atlas.contracts
          .filter((contract) => command.contracts.includes(contract.contract))
          .flatMap((contract) => contract.states.flatMap((state) => state.stories)),
      ]);
      return [...keys].flatMap(
        (key) => atlas.stories.find((story) => story.key === key)?.color ?? [],
      );
    }
    case "Flow":
      return flowPath(atlas, route.flow)
        .slice(Math.max(route.step - 2, 0), route.step + 1)
        .map(({ step }) => step.frame);
    case "Story":
      return atlas.stories.filter((story) => story.key === route.key).map((story) => story.color);
    case "Error":
      return atlas.stories
        .filter((story) =>
          story.errorTags.includes(
            atlas.errors.find((error) => errorKey(error) === route.path)?.tag ?? "",
          ),
        )
        .map((story) => story.color);
    case "Errors":
    case "Services":
    case "Service":
    case "Persistence":
    case "PersistedStore":
      return [];
    case "TerminalOutputVocabulary":
      return [...atlas.frames, ...atlas.blocks].map((example) => example.color);
    case "Vocabulary":
    case "Overview":
    case "Flows":
    case "Coverage":
    case "Issues":
    case "NotFound":
      return [];
  }
}

/** Starts loading the frames a page shows that are not loaded or loading yet. */
const loadFrames = (model: Model, atlas: Atlas, route: AppRoute) => {
  const missing = [
    ...new Set(framesOn(atlas, route).map((path) => framePath(atlas, path, model.color))),
  ].filter((path) => model.frames[path] === undefined);
  return {
    frames: {
      ...model.frames,
      ...Object.fromEntries(missing.map((path) => [path, FrameData.Loading()])),
    },
    commands: missing.map((path) => LoadFrame({ path })),
  };
};

export const NavigateTo = Command.define("NavigateTo", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigation],
  execute: ({ url }) => Navigation.pushUrl(url).pipe(Effect.as(Message.CompletedNavigation())),
});

const LoadExternal = Command.define("LoadExternal", {
  args: { href: Schema.String },
  messages: [Message.CompletedNavigation],
  execute: ({ href }) => Navigation.load(href).pipe(Effect.as(Message.CompletedNavigation())),
});

export const ScrollToTop = Command.define("ScrollToTop", {
  messages: [Message.CompletedScrollToTop],
  execute: Effect.sync(() => {
    window.scrollTo({ top: 0 });
    return Message.CompletedScrollToTop();
  }),
});

/** Everything ⌘K can jump to, each with the page it opens. */
export function paletteEntries(
  atlas: Atlas,
): ReadonlyArray<{ readonly href: string; readonly item: CommandMenu.Item }> {
  const rows = [
    { href: overviewHref, label: "Every command", group: "Pages" },
    { href: flowsHref, label: "Flows", group: "Pages" },
    { href: coverageHref, label: "Coverage", group: "Pages" },
    { href: errorsHref, label: "Errors", group: "Pages" },
    { href: persistenceHref, label: "Persisted data", group: "Pages" },
    { href: servicesHref, label: "Services", group: "Pages" },
    ...atlas.systemMap.services.map((service) => ({
      href: serviceHref(service.id),
      label: serviceName(service),
      group: "Services",
      description: service.file,
      keywords: [
        service.identifier,
        service.kind,
        ...service.operations.map((operation) => operation.name),
      ],
    })),
    ...atlas.persistence.map((store) => ({
      href: storeHref(store.id),
      label: store.name,
      group: "Persisted data",
      description: store.paths.join(" | "),
      keywords: [
        store.owner,
        store.format,
        store.scope,
        store.description,
        ...store.paths,
        ...store.definitions.map(
          (definition) => `${definition.name} ${definition.file} ${definition.source}`,
        ),
      ],
    })),
    ...atlas.errors.map((error) => ({
      href: errorHref(errorKey(error)),
      label: error.name,
      description: error.services.join(" | ") || error.file,
      keywords: [
        error.file,
        ...error.services,
        ...errorExamples(atlas, error).map((story) => story.text),
      ],
      group: "Errors",
    })),
    { href: issuesHref, label: "Copy issues", group: "Pages" },
    { href: vocabularyHref, label: "Vocabulary", group: "Pages" },
    {
      href: terminalOutputVocabularyHref,
      label: terminalOutputVocabularyTitle,
      keywords: ["Terminal frames", "Blocks"],
      group: "Pages",
    },
    ...atlas.commands.map(({ command }) => ({
      href: commandHref(command),
      label: `skit ${command}`,
      group: "Commands",
    })),
    ...atlas.flows.map((flow) => ({
      href: flowHref(flow.name, 1),
      label: flow.name,
      description: plural(flowPath(atlas, flow.name).length, "step"),
      group: "Flows",
    })),
    ...atlas.stories.map((story) => ({
      href: storyHref(story.key),
      label: story.key,
      group: "Stories",
    })),
    ...copyIssues(atlas).flatMap(({ issue, places }) =>
      places[0] === undefined
        ? []
        : [
            {
              href: placeHref(places[0]),
              label: issue.text,
              description: plural(places.length, "place"),
              group: "Copy issues",
            },
          ],
    ),
  ];
  // Rows can share a link, such as a flow's first step and an issue it shows, so a row's
  // group and label keep its value unique.
  return rows.map(({ href, ...item }) => ({
    href,
    item: { ...item, value: `${item.group} ${item.label} ${href}` },
  }));
}

export const init: Runtime.RoutingApplicationInit<Model, Message, void, HttpClient.HttpClient> = (
  url,
) => {
  const route = routeOf(url);
  return {
    model: {
      route,
      atlas: AtlasData.Loading(),
      frames: {},
      color: true,
      errorQuery: "",
      persistenceQuery: "",
      serviceQuery: "",
      activeServiceNode: { id: "", input: "pointer" },
      sidebar: Sidebar.init({ id: "atlas-nav", width: "15rem" }),
      breadcrumb: Breadcrumb.init({ id: "atlas-trail" }),
      palette: CommandDialog.init({ id: "atlas-palette" }),
      commandTabs: Tabs.init({ id: "command-tabs" }),
      guarantees: Accordion.init({ items: [], type: "multiple" }),
      recordingDetails: Accordion.init({ items: [], type: "multiple" }),
      detailDisclosures: Accordion.init({ items: [], type: "multiple" }),
      frameDialog: Dialog.init({ id: "frame-dialog" }),
      fullSize: { frame: "", title: "" },
      tips: {},
    },
    commands: [LoadAtlas()],
  };
};

/** Lifts a child component's Commands into Atlas Messages. */
const lift = <ChildMessage>(
  commands: ReadonlyArray<Command.Command<ChildMessage>> | undefined,
  wrap: (message: ChildMessage) => Message,
) => (commands ?? []).map((command) => Command.mapMessage(command, wrap));

export function update(
  model: Model,
  message: Message,
): Update.Return<Model, Message, HttpClient.HttpClient> {
  switch (message._tag) {
    case "ClickedLink":
      return {
        model,
        commands: [
          message.request._tag === "Internal"
            ? NavigateTo({ url: Url.toString(message.request.url) })
            : LoadExternal({ href: message.request.href }),
        ],
      };
    case "ChangedUrl": {
      const route = routeOf(message.url);
      const sameCommand =
        route._tag === "Command" &&
        model.route._tag === "Command" &&
        route.path === model.route.path &&
        route.test === model.route.test;
      // Stepping through one flow keeps the step list where it is.
      const sameFlow =
        route._tag === "Flow" && model.route._tag === "Flow" && route.flow === model.route.flow;
      const loading = AsyncData.isSuccess(model.atlas)
        ? loadFrames(model, model.atlas.data, route)
        : { frames: model.frames, commands: [] };
      return {
        model: {
          ...model,
          route,
          activeServiceNode: { id: "", input: "pointer" },
          guarantees:
            sameCommand || !AsyncData.isSuccess(model.atlas)
              ? model.guarantees
              : initialGuarantees(model.atlas.data, route),
          recordingDetails: sameFlow ? model.recordingDetails : { expanded: [] },
          detailDisclosures: { expanded: [] },
          frames: loading.frames,
          sidebar: { ...model.sidebar, openMobile: false },
        },
        commands: [...(sameFlow ? [] : [ScrollToTop()]), ...loading.commands],
      };
    }
    case "LoadedAtlas": {
      const loading = loadFrames(model, message.atlas, model.route);
      return {
        model: {
          ...model,
          atlas: AtlasData.Success({ data: message.atlas }),
          guarantees: initialGuarantees(message.atlas, model.route),
          frames: loading.frames,
        },
        commands: loading.commands,
      };
    }
    case "LoadedFrame":
      return {
        model: {
          ...model,
          frames: { ...model.frames, [message.path]: FrameData.Success({ data: message.frame }) },
        },
      };
    case "FailedToLoadFrame":
      return {
        model: {
          ...model,
          frames: { ...model.frames, [message.path]: FrameData.Failure({ error: message.reason }) },
        },
      };
    case "FailedToLoadAtlas":
      return { model: { ...model, atlas: AtlasData.Failure({ error: message.reason }) } };
    case "CompletedNavigation":
    case "CompletedScrollToTop":
      return { model };
    case "PressedArrowKey": {
      if (model.route._tag !== "Flow" || !AsyncData.isSuccess(model.atlas)) return { model };
      const steps = flowPath(model.atlas.data, model.route.flow).length;
      const step = model.route.step + (message.direction === "next" ? 1 : -1);
      return step < 1 || step > steps
        ? { model }
        : { model, commands: [NavigateTo({ url: flowHref(model.route.flow, step) })] };
    }
    case "ClickedFullSize": {
      const result = Dialog.update(model.frameDialog, Dialog.Message.RequestedOpen());
      return {
        model: {
          ...model,
          fullSize: { frame: message.frame, title: message.title },
          frameDialog: result.model,
        },
        commands: lift(result.commands, (message) => Message.FrameDialog({ message })),
      };
    }
    case "ChangedPersistenceQuery":
      return { model: { ...model, persistenceQuery: message.query } };
    case "ChangedServiceQuery":
      return { model: { ...model, serviceQuery: message.query } };
    case "ChangedServiceNode": {
      const current = model.activeServiceNode;
      // Focus owns emphasis until blur; pointer enter/leave during scrolling cannot replace it.
      if (message.input === "pointer" && current.input === "focus") return { model };
      if (message.clear && (current.id !== message.id || current.input !== message.input))
        return { model };
      const activeServiceNode: Model["activeServiceNode"] = {
        id: message.clear ? "" : message.id,
        input: message.clear ? "pointer" : message.input,
      };
      return {
        model:
          activeServiceNode.id === current.id && activeServiceNode.input === current.input
            ? model
            : { ...model, activeServiceNode },
      };
    }
    case "ChangedErrorQuery":
      return { model: { ...model, errorQuery: message.query } };
    case "ChangedColor": {
      const next = { ...model, color: message.checked };
      const loading = AsyncData.isSuccess(next.atlas)
        ? loadFrames(next, next.atlas.data, next.route)
        : { frames: next.frames, commands: [] };
      return { model: { ...next, frames: loading.frames }, commands: loading.commands };
    }
    case "Sidebar": {
      const result = Sidebar.update(model.sidebar, message.message);
      return {
        model: { ...model, sidebar: result.model },
        commands: lift(result.commands, (message) => Message.Sidebar({ message })),
      };
    }
    case "Breadcrumb": {
      const result = Breadcrumb.update(model.breadcrumb, message.message);
      return {
        model: { ...model, breadcrumb: result.model },
        commands: [
          ...lift(result.commands, (message) => Message.Breadcrumb({ message })),
          ...(result.outMessage ? [NavigateTo({ url: result.outMessage.value })] : []),
        ],
      };
    }
    case "Palette": {
      const entries = AsyncData.isSuccess(model.atlas) ? paletteEntries(model.atlas.data) : [];
      const result = CommandDialog.update(model.palette, message.message, {
        items: entries.map(({ item }) => item),
      });
      const picked = result.outMessage?._tag === "Selected" ? result.outMessage.value : undefined;
      return {
        model: { ...model, palette: result.model },
        commands: [
          ...lift(result.commands, (message) => Message.Palette({ message })),
          ...entries
            .filter(({ item }) => item.value === picked)
            .map(({ href }) => NavigateTo({ url: href })),
        ],
      };
    }
    case "Guarantees": {
      const groups =
        AsyncData.isSuccess(model.atlas) && model.route._tag === "Command"
          ? commandGuarantees(model.atlas.data, model.route.path.replaceAll("/", " "))
          : [];
      return {
        model: {
          ...model,
          guarantees: Accordion.update(model.guarantees, message.message, {
            type: "multiple",
            items: groups.map((group) => ({ value: group.key, label: group.title })),
          }),
        },
      };
    }
    case "CommandTabs": {
      const result = Tabs.update(model.commandTabs, message.message);
      return {
        model: {
          ...model,
          commandTabs: result.model,
        },
        commands: [
          ...lift(result.commands, (message) => Message.CommandTabs({ message })),
          ...(model.route._tag === "Command" && Schema.is(CommandTab)(result.outMessage?.value)
            ? [
                NavigateTo({
                  url: commandTabHref(
                    model.route.path.replaceAll("/", " "),
                    result.outMessage.value,
                  ),
                }),
              ]
            : []),
        ],
      };
    }
    case "DetailDisclosures": {
      const route = model.route;
      const error =
        AsyncData.isSuccess(model.atlas) && route._tag === "Error"
          ? model.atlas.data.errors.find((error) => `${error.file}/${error.name}` === route.path)
          : undefined;
      const store =
        AsyncData.isSuccess(model.atlas) && route._tag === "PersistedStore"
          ? model.atlas.data.persistence.find((store) => store.id === route.id)
          : undefined;
      return {
        model: {
          ...model,
          detailDisclosures: Accordion.update(model.detailDisclosures, message.message, {
            type: "multiple",
            items: error
              ? errorDisclosures(error)
              : store
                ? storeDisclosures(store)
                : AsyncData.isSuccess(model.atlas)
                  ? mapDisclosures(model.atlas.data, route)
                  : [],
          }),
        },
      };
    }
    case "RecordingDetails":
      return {
        model: {
          ...model,
          recordingDetails: Accordion.update(model.recordingDetails, message.message, {
            type: "multiple",
            items: [{ value: "recording", label: "Recording setup and evidence" }],
          }),
        },
      };
    case "FrameDialog": {
      const result = Dialog.update(model.frameDialog, message.message);
      return {
        model: { ...model, frameDialog: result.model },
        commands: lift(result.commands, (message) => Message.FrameDialog({ message })),
      };
    }
    case "Tip": {
      const result = Tooltip.update(tipOf(model, message.key), message.message);
      return {
        model: { ...model, tips: { ...model.tips, [message.key]: result.model } },
        commands: lift(result.commands, (inner) =>
          Message.Tip({ key: message.key, message: inner }),
        ),
      };
    }
  }
}

/** Focus in a list that moves with the arrow keys keeps them; elsewhere they step the flow. */
const arrowsFree = () =>
  !document.activeElement?.closest(
    '[data-sidebar="menu"],[role="tablist"],[role="menu"],[role="listbox"],[role="combobox"]',
  );

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  palette: entry(
    { active: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ active: AsyncData.isSuccess(model.atlas) }),
      dependenciesToStream: ({ active }) =>
        active
          ? CommandDialog.shortcut("mod+k").pipe(
              Stream.map(() => Message.Palette({ message: CommandDialog.Message.Toggled() })),
            )
          : Stream.empty,
    },
  ),
  flowSteps: entry(
    { active: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ active: model.route._tag === "Flow" }),
      dependenciesToStream: ({ active }) =>
        active
          ? Stream.merge(
              CommandDialog.shortcut("left", arrowsFree).pipe(
                Stream.map(() => Message.PressedArrowKey({ direction: "previous" })),
              ),
              CommandDialog.shortcut("right", arrowsFree).pipe(
                Stream.map(() => Message.PressedArrowKey({ direction: "next" })),
              ),
            )
          : Stream.empty,
    },
  ),
}));

/** The trail to the current page; a menu step lists the pages beside it. */
function trail(atlas: Atlas, route: AppRoute): readonly Breadcrumb.Item[] {
  const home = { value: "atlas", label: "Atlas", href: overviewHref };
  const commandTrail = (command: string): readonly Breadcrumb.Item[] => [
    home,
    { value: "commands", label: "Commands", href: overviewHref },
    { value: "command", label: `skit ${command}`, href: commandHref(command) },
  ];
  switch (route._tag) {
    case "Overview":
      return [{ ...home, label: "Every command" }];
    case "Flows":
      return [home, { value: "flows", label: "Flows" }];
    case "Coverage":
      return [home, { value: "coverage", label: "Coverage" }];
    case "Command":
      return commandTrail(route.path.replaceAll("/", " "));
    case "Flow": {
      const flow = atlas.flows.find((candidate) => candidate.name === route.flow);
      const command = flow?.commands.length === 1 ? flow.commands[0] : undefined;
      return [
        ...(command === undefined ? [home] : commandTrail(command)),
        {
          value: "flows",
          label: "Flows",
          href: command === undefined ? flowsHref : commandTabHref(command, "flows"),
        },
        { value: "flow", label: route.flow },
      ];
    }

    case "Story": {
      const commands = atlas.commands.filter((entry) => entry.stories.includes(route.key));
      const command = commands.length === 1 ? commands[0] : undefined;
      return [
        ...(command === undefined
          ? [home]
          : [
              ...commandTrail(command.command),
              {
                value: "results",
                label: commandResultsLabel(atlas, command),
                href: commandTabHref(command.command, "results"),
              },
            ]),
        { value: "story", label: route.key },
      ];
    }

    case "Persistence":
      return [home, { value: "data", label: "Persisted data" }];
    case "PersistedStore":
      return [
        home,
        { value: "data", label: "Persisted data", href: persistenceHref },
        {
          value: "store",
          label: atlas.persistence.find((store) => store.id === route.id)?.name ?? route.id,
        },
      ];
    case "Services":
      return [home, { value: "services", label: "Services" }];
    case "Service": {
      const service = atlas.systemMap.services.find((service) => service.id === route.id);
      return [
        home,
        { value: "services", label: "Services", href: servicesHref },
        { value: "service", label: service ? serviceName(service) : route.id },
      ];
    }
    case "Errors":
      return [home, { value: "errors", label: "Errors" }];
    case "Error":
      return [
        home,
        { value: "errors", label: "Errors", href: errorsHref },
        { value: "error", label: route.path.split("/").at(-1) ?? "Error" },
      ];
    case "Issues":
      return [home, { value: "issues", label: "Copy issues" }];
    case "Vocabulary":
      return [home, { value: "vocabulary", label: "Vocabulary" }];
    case "TerminalOutputVocabulary":
      return [home, { value: "terminal-output-vocabulary", label: terminalOutputVocabularyTitle }];
    case "NotFound":
      return [home, { value: "missing", label: "Not found" }];
  }
}

function page(atlas: Atlas, model: Model, h: HtmlBuilder<Message>): Html {
  const route = model.route;
  switch (route._tag) {
    case "Overview":
      return overview(atlas, model, h);
    case "Flows":
      return flowsPage(atlas, h);
    case "Coverage":
      return coveragePage(atlas, model, h);
    case "Command": {
      const command = atlas.commands.find(
        (entry) => entry.command === route.path.replaceAll("/", " "),
      );
      return command === undefined || commandTabFor(atlas, route) === undefined
        ? notFoundPage(h, `command skit ${route.path.replaceAll("/", " ")}`)
        : commandPage(atlas, command, model, h);
    }
    case "Flow": {
      const flow = atlas.flows.find((candidate) => candidate.name === route.flow);
      return flow === undefined
        ? notFoundPage(h, `flow ${route.flow}`)
        : flowPage(atlas, flow, route.step, model, h);
    }
    case "Story": {
      const story = atlas.stories.find((candidate) => candidate.key === route.key);
      return story === undefined
        ? notFoundPage(h, `story ${route.key}`)
        : storyPage(atlas, story, model, h);
    }
    case "Persistence":
      return persistencePage(atlas, model, h);
    case "PersistedStore": {
      const store = atlas.persistence.find((store) => store.id === route.id);
      return store
        ? persistedStorePage(atlas, store, model, h)
        : notFoundPage(h, `persisted store ${route.id}`);
    }
    case "Services":
      return servicesPage(atlas, model, h);
    case "Service": {
      const service = atlas.systemMap.services.find((service) => service.id === route.id);
      return service
        ? servicePage(atlas, service, model, h)
        : notFoundPage(h, `service ${route.id}`);
    }
    case "Errors":
      return errorsPage(atlas, model, h);
    case "Error": {
      const error = atlas.errors.find((error) => errorKey(error) === route.path);
      return error ? errorPage(atlas, error, model, h) : notFoundPage(h, `error ${route.path}`);
    }
    case "Issues":
      return issuesPage(atlas, h);
    case "Vocabulary":
      return vocabularyPage(atlas, h);
    case "TerminalOutputVocabulary":
      return terminalOutputVocabularyPage(atlas, model, h);
    case "NotFound":
      return notFoundPage(h, `page ${route.path}`);
  }
}

/** The full-size dialog: in a flow it follows the open step, so Left and Right step through it. */
function fullSizeFrame(atlas: Atlas, model: Model) {
  const route = model.route;
  if (route._tag !== "Flow") return model.fullSize;
  const path = flowPath(atlas, route.flow);
  const step = path[Math.min(Math.max(route.step, 1), path.length) - 1]?.step;
  return step === undefined
    ? model.fullSize
    : { frame: step.frame, title: `${route.flow}, step ${route.step}: ${step.label}` };
}

/** The CLI's words form the navigation tree; Fluid owns submenu interaction and rendering. */
function commandNavigation(
  atlas: Atlas,
  model: Model,
  h: HtmlBuilder<Message>,
): readonly Sidebar.MenuRow<Message>[] {
  const rows = (
    commands: Atlas["commands"],
    prefix: string,
  ): readonly Sidebar.MenuRow<Message>[] => {
    const words = [
      ...new Set(commands.map(({ command }) => command.slice(prefix.length).split(" ")[0]!)),
    ];
    return words.map((word) => {
      const path = `${prefix}${word}`;
      const command = commands.find((entry) => entry.command === path);
      if (command)
        return {
          key: path,
          label: word,
          ariaLabel: `skit ${path}`,
          href: commandHref(path),
          active: model.route._tag === "Command" && model.route.path === path.replaceAll(" ", "/"),
        };
      const children = commands.filter(({ command }) => command.startsWith(`${path} `));
      const open = model.sidebar.groups[path] ?? true;
      return {
        key: path,
        label: word,
        count: children.length,
        trailing: [
          h.span(
            [
              h.Class("ff-sidebar-chevron"),
              h.DataAttribute("open", String(open)),
              h.AriaHidden(true),
            ],
            [icon("chevron-right", undefined, h)],
          ),
        ],
        onClick: Message.Sidebar({
          message: Sidebar.Message.GroupToggled({ key: path, defaultOpen: true }),
        }),
        attributes: [h.AriaExpanded(open)],
        renderButton: (attributes, children) =>
          h.button([h.Type("button"), ...attributes], children),
        sub: { open, rows: rows(children, `${path} `) },
      };
    });
  };
  return rows(
    commandGroups(atlas).flatMap(({ commands }) => commands),
    "",
  );
}

function shell(atlas: Atlas, model: Model, h: HtmlBuilder<Message>): Html {
  const kit: Sidebar.Kit<Message> = {
    h,
    size: "compact",
    toMessage: (message) => Message.Sidebar({ message }),
  };
  const route = model.route;
  const items = paletteEntries(atlas).map(({ item }) => item);
  const frame = fullSizeFrame(atlas, model);
  const issues = copyIssues(atlas).length;
  return Sidebar.provider(
    model.sidebar,
    {},
    [
      ...Sidebar.sidebar(
        model.sidebar,
        {
          height: "h-svh",
          className:
            "[&_[data-sidebar=content]]:gap-4 [&_[data-sidebar=menu]]:gap-0 [&_[data-sidebar=menu-sub]]:gap-0 [&_[data-sidebar=menu-sub]]:w-auto [&_[data-sidebar=menu-button]]:min-h-0 [&_[data-sidebar=menu-sub-button]]:min-h-0",
        },
        [
          Sidebar.header(
            [
              Sidebar.Blocks.workspaceHeader(
                model.sidebar,
                { name: "SKIT CLI Atlas", tile: Sidebar.Blocks.workspaceTile("S", kit) },
                kit,
              ),
              Sidebar.Blocks.searchField(kit, {
                placeholder: "Jump to…",
                attributes: [
                  h.AriaLabel("Jump to"),
                  h.Attribute("readonly", ""),
                  h.OnClick(Message.Palette({ message: CommandDialog.Message.Opened() })),
                  h.OnKeyDownPreventDefault((key) =>
                    key === "Enter" || key === " "
                      ? Option.some(Message.Palette({ message: CommandDialog.Message.Opened() }))
                      : Option.none(),
                  ),
                ],
              }),
            ],
            kit,
          ),
          Sidebar.content(
            model.sidebar,
            [
              Sidebar.group(
                model.sidebar,
                {
                  key: "atlas",
                  label: "Atlas",
                  className:
                    "gap-0 [&>[data-sidebar=group-label]]:w-auto [&>[data-sidebar=group-label]]:mx-2 [&>[data-sidebar=group-label]]:px-0 [&>[data-sidebar=group-label]]:text-foreground",
                  count: 9,
                },
                [
                  Sidebar.separator(kit, "mb-2"),
                  Sidebar.menu(
                    [
                      {
                        key: "overview",
                        label: "Every command",
                        href: overviewHref,
                        active: route._tag === "Overview",
                      },
                      {
                        key: "flows",
                        label: "Flows",
                        count: atlas.flows.length,
                        href: flowsHref,
                        active: route._tag === "Flows" || route._tag === "Flow",
                      },
                      {
                        key: "coverage",
                        label: "Coverage",
                        href: coverageHref,
                        active: route._tag === "Coverage",
                      },
                      {
                        key: "data",
                        label: "Persisted data",
                        count: atlas.persistence.length,
                        href: persistenceHref,
                        active: route._tag === "Persistence" || route._tag === "PersistedStore",
                      },
                      {
                        key: "services",
                        label: "Services",
                        count: localServices(atlas).length,
                        href: servicesHref,
                        active: route._tag === "Services" || route._tag === "Service",
                      },
                      {
                        key: "errors",
                        label: "Errors",
                        count: atlas.errors.length,
                        href: errorsHref,
                        active: route._tag === "Errors" || route._tag === "Error",
                      },
                      {
                        key: "issues",
                        label: "Copy issues",
                        count: issues,
                        href: issuesHref,
                        active: route._tag === "Issues",
                      },
                      {
                        key: "vocabulary",
                        label: "Vocabulary",
                        href: vocabularyHref,
                        active: route._tag === "Vocabulary",
                      },
                      {
                        key: "terminal-output-vocabulary",
                        label: terminalOutputVocabularyTitle,
                        href: terminalOutputVocabularyHref,
                        count: atlas.frames.length + atlas.blocks.length,
                        active: route._tag === "TerminalOutputVocabulary",
                      },
                    ],
                    { model: model.sidebar, label: "Atlas pages" },
                    kit,
                  ),
                ],
                kit,
              ),
              Sidebar.group(
                model.sidebar,
                {
                  key: "commands",
                  label: "Commands",
                  className:
                    "gap-0 [&>[data-sidebar=group-label]]:w-auto [&>[data-sidebar=group-label]]:mx-2 [&>[data-sidebar=group-label]]:px-0 [&>[data-sidebar=group-label]]:text-foreground",
                  count: atlas.commands.length,
                },
                [
                  Sidebar.separator(kit, "mb-2"),
                  Sidebar.menu(
                    commandNavigation(atlas, model, h),
                    { model: model.sidebar, label: "Commands" },
                    kit,
                  ),
                ],
                kit,
              ),
            ],
            kit,
          ),
          Sidebar.footer(
            [
              Switch.view(
                {
                  id: "atlas-color",
                  size: "compact",
                  label: "Colour",
                  checked: model.color,
                  onToggle: (checked) => Message.ChangedColor({ checked }),
                },
                h,
              ),
            ],
            kit,
          ),
        ],
        kit,
      ),
      Sidebar.inset(
        [
          Sidebar.Blocks.insetTopbar(
            model.sidebar,
            [
              h.submodel({
                slotId: "trail",
                model: model.breadcrumb,
                view: Breadcrumb.view,
                toParentMessage: (message) => Message.Breadcrumb({ message }),
                viewInputs: { items: trail(atlas, route), collapse: "overflow", reveal: "menu" },
              }),
            ],
            kit,
            "sticky top-0 z-20 bg-background",
          ),
          page(atlas, model, h),
          h.submodel({
            slotId: "palette",
            model: model.palette,
            view: CommandDialog.view,
            toParentMessage: (message) => Message.Palette({ message }),
            viewInputs: {
              items,
              title: "Jump to",
              description:
                "Search commands, flows, stories, persisted data, services and copy issues.",
              placeholder:
                "Search commands, flows, stories, persisted data, services and copy issues",
              empty: "Nothing in the Atlas matches.",
              footer: true,
            },
          }),
          h.submodel({
            slotId: "frame",
            model: model.frameDialog,
            view: Dialog.view,
            toParentMessage: (message) => Message.FrameDialog({ message }),
            viewInputs: {
              title: frame.title,
              hideTrigger: true,
              width: "2xl",
              renderContent: () => frameView(model, h, frame.frame, frame.title),
            },
          }),
        ],
        kit,
      ),
    ],
    kit,
  );
}

const titleOf = (route: AppRoute) => {
  switch (route._tag) {
    case "Overview":
      return "SKIT CLI Atlas";
    case "Flows":
      return "Flows | Atlas";
    case "Coverage":
      return "Coverage | Atlas";
    case "Command":
      return `skit ${route.path.replaceAll("/", " ")} | Atlas`;
    case "Flow":
      return `${route.flow} step ${route.step} | Atlas`;
    case "Story":
      return `${route.key} | Atlas`;
    case "Persistence":
      return "Persisted data | Atlas";
    case "PersistedStore":
      return `${route.id} | Atlas`;
    case "Services":
      return "Services | Atlas";
    case "Service":
      return `${route.id.split("#").at(-1)} | Atlas`;
    case "Errors":
      return "Errors | Atlas";
    case "Error":
      return `${route.path.split("/").at(-1)} | Atlas`;
    case "Issues":
      return "Copy issues | Atlas";
    case "Vocabulary":
      return "Vocabulary | Atlas";
    case "TerminalOutputVocabulary":
      return `${terminalOutputVocabularyTitle} | Atlas`;
    case "NotFound":
      return "Not found | Atlas";
  }
};

export function view(model: Model, h: HtmlBuilder<Message>): Document {
  return {
    title: titleOf(model.route),
    body: AsyncData.match(model.atlas, {
      onIdle: () => h.p([h.Class("m-0 p-8"), h.Role("status")], ["Loading the Atlas…"]),
      onLoading: () => h.p([h.Class("m-0 p-8"), h.Role("status")], ["Loading the Atlas…"]),
      onRefreshing: (atlas) => shell(atlas, model, h),
      onStale: ({ data }) => shell(data, model, h),
      onSuccess: (atlas) => shell(atlas, model, h),
      onFailure: (reason) =>
        h.p(
          [h.Class("m-0 p-8"), h.Role("alert")],
          [
            `Could not load atlas.json (${reason}). Run pnpm atlas in packages/storybook to generate it.`,
          ],
        ),
    }),
  };
}
