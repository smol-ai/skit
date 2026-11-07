import { Context } from "effect";

export interface ServerConfigurationService {
  readonly publicAppOrigin: string;
}

export class ServerConfiguration extends Context.Service<
  ServerConfiguration,
  ServerConfigurationService
>()("@skit-server-effect/ServerConfiguration") {}
