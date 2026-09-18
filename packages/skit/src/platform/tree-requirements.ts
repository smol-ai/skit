import { FileSystem, Path } from "effect";
import { LinkStat } from "./link-stat.js";
import { SourceProcess } from "./source-process.js";

export type TreeRequirements = FileSystem.FileSystem | Path.Path | LinkStat | SourceProcess;
