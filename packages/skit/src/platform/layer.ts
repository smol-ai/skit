// The Node platform layer SKIT workflows run on. Workflows yield Effects; only a process
// entrypoint provides this layer and enters the runtime (docs/adr/0018-own-cli-workflows-with-effect.md).

import { Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { TreeHasher, treeHasherLayer } from "../artifact/tree-hasher.js";
import { linkStatLayer, LinkStat } from "./link-stat.js";
import { sourceProcessLayer, SourceProcess } from "./source-process.js";

export type SkitServices =
  | NodeServices.NodeServices
  | LinkStat
  | HttpClient.HttpClient
  | TreeHasher
  | SourceProcess;

export const skitLayer: Layer.Layer<SkitServices> = Layer.mergeAll(
  NodeServices.layer,
  linkStatLayer,
  FetchHttpClient.layer,
  treeHasherLayer,
  sourceProcessLayer.pipe(Layer.provide(NodeServices.layer)),
);
