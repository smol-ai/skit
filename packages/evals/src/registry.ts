import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A device login the Registry started: what the user would be asked to open and type. */
export interface IssuedLogin {
  readonly userCode: string;
  readonly verificationUri: string;
}

/**
 * A local Registry that speaks only the device-login protocol `skit auth login` uses: discovery,
 * device authorization, and a token endpoint that is always still waiting for approval. Nobody
 * approves a code, so a login can be started and reported but never completed, exactly as when the
 * user has stepped away. It keeps trials off the network and records every code it issued, so a
 * check can tell a real code from one the agent made up.
 */
export interface LocalRegistry {
  readonly origin: string;
  readonly issued: readonly IssuedLogin[];
  close(): Promise<void>;
}

export async function startLocalRegistry(): Promise<LocalRegistry> {
  const issued: IssuedLogin[] = [];
  const server = createServer((request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const { pathname } = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && pathname === "/.well-known/skit")
      return reply(200, {
        schema: "skit.server.v1",
        download: "/api/download",
        scopes: ["library:sync", "authoring:write", "publication:write"],
        deviceAuthorization: "/api/auth/device/code",
        deviceToken: "/api/auth/device/token",
      });
    if (request.method === "POST" && pathname === "/api/auth/device/code") {
      const login = {
        userCode: randomBytes(4).toString("hex").toUpperCase(),
        verificationUri: `${origin}/device`,
      };
      issued.push(login);
      return reply(200, {
        device_code: randomBytes(16).toString("hex"),
        user_code: login.userCode,
        verification_uri: login.verificationUri,
        expires_in: 600,
        interval: 5,
      });
    }
    if (request.method === "POST" && pathname === "/api/auth/device/token")
      return reply(400, { error: "authorization_pending" });
    reply(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    issued,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
