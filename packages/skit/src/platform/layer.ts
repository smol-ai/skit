// The Node platform layer SKIT workflows run on. Workflows yield Effects; only a process
// entrypoint provides this layer and enters the runtime (docs/adr/0018-own-cli-workflows-with-effect.md).

import { Layer } from "effect";
import { NodeCrypto, NodeServices } from "@effect/platform-node";
import type { Digest, SecureRandom } from "effect/crypto";
import { FetchHttpClient, HttpClient } from "effect/http";
import { TreeHasher, treeHasherLayer } from "../artifact/tree-hasher.js";
import { linkStatLayer, LinkStat } from "./link-stat.js";
import { sourceProcessLayer, SourceProcess } from "./source-process.js";
import {
  authorIgnoreRepositoryLayer,
  AuthorIgnoreRepository,
} from "../artifact/plain-author-ignore.js";

export type SkitServices =
  | NodeServices.NodeServices
  | Digest.Digest
  | SecureRandom.SecureRandom
  | LinkStat
  | HttpClient.HttpClient
  | TreeHasher
  | SourceProcess
  | AuthorIgnoreRepository;

export const skitLayer: Layer.Layer<SkitServices> = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layerDigest,
  NodeCrypto.layerSecureRandom,
  linkStatLayer,
  FetchHttpClient.layer,
  treeHasherLayer,
  sourceProcessLayer.pipe(Layer.provide(NodeServices.layer)),
  authorIgnoreRepositoryLayer,
);
