import { Schema } from "effect";
import { AsyncData, Navigation, Url } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { Atlas, Frame } from "../../src/atlas/data.ts";
import * as Accordion from "./fluid/components/accordion";
import * as Breadcrumb from "./fluid/components/breadcrumb";
import * as CommandDialog from "./fluid/components/command-menu/dialog";
import * as Dialog from "./fluid/components/dialog";
import * as Sidebar from "./fluid/components/sidebar";
import * as Tabs from "./fluid/components/tabs";
import * as Tooltip from "./fluid/components/tooltip";
import { AppRoute } from "./route.ts";

export const AtlasData = AsyncData.Schema(Atlas, Schema.String);
export const FrameData = AsyncData.Schema(Frame, Schema.String);

export const Model = Schema.Struct({
  route: AppRoute,
  atlas: AtlasData.schema,
  /** Terminal frames by path, each loaded when a page first shows it. */
  frames: Schema.Record(Schema.String, FrameData.schema),
  color: Schema.Boolean,
  errorQuery: Schema.String,
  persistenceQuery: Schema.String,
  serviceQuery: Schema.String,
  activeServiceNode: Schema.Struct({
    id: Schema.String,
    input: Schema.Literals(["pointer", "focus"]),
  }),
  sidebar: Sidebar.Model,
  breadcrumb: Breadcrumb.Model,
  palette: CommandDialog.Model,
  commandTabs: Tabs.Model,
  guarantees: Accordion.Model,
  recordingDetails: Accordion.Model,
  detailDisclosures: Accordion.Model,
  frameDialog: Dialog.Model,
  /** The terminal the full-size dialog shows outside a flow; in a flow it shows the open step. */
  fullSize: Schema.Struct({ frame: Schema.String, title: Schema.String }),
  /** Each tooltip's state, created when first shown. */
  tips: Schema.Record(Schema.String, Tooltip.Model),
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  ClickedLink: { request: Navigation.UrlRequest },
  ChangedUrl: { url: Url.Url },
  LoadedAtlas: { atlas: Atlas },
  FailedToLoadAtlas: { reason: Schema.String },
  LoadedFrame: { path: Schema.String, frame: Frame },
  FailedToLoadFrame: { path: Schema.String, reason: Schema.String },
  CompletedNavigation: {},
  CompletedScrollToTop: {},
  PressedArrowKey: { direction: Schema.Literals(["previous", "next"]) },
  ClickedFullSize: { frame: Schema.String, title: Schema.String },
  ChangedPersistenceQuery: { query: Schema.String },
  ChangedServiceQuery: { query: Schema.String },
  ChangedServiceNode: {
    id: Schema.String,
    clear: Schema.Boolean,
    input: Schema.Literals(["pointer", "focus"]),
  },
  ChangedErrorQuery: { query: Schema.String },
  ChangedColor: { checked: Schema.Boolean },
  Sidebar: { message: Sidebar.Message },
  Breadcrumb: { message: Breadcrumb.Message },
  Palette: { message: CommandDialog.Message },
  CommandTabs: { message: Tabs.Message },
  Guarantees: { message: Accordion.Message },
  RecordingDetails: { message: Accordion.Message },
  DetailDisclosures: { message: Accordion.Message },
  FrameDialog: { message: Dialog.Message },
  Tip: { key: Schema.String, message: Tooltip.Message },
});
export type Message = typeof Message.Type;

/** A tooltip's state; one that has not been shown yet starts closed. */
export const tipOf = (model: Model, key: string) =>
  model.tips[key] ?? Tooltip.init({ id: `tip-${key.replace(/\W+/g, "-")}` });
