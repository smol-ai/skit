import { Context } from "effect";
import type { Interface } from "./library.js";

export class Service extends Context.Service<Service, Interface>()("skit/library/Library") {}
