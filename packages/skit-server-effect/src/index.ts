import { Server } from "foldkit/experimental";
import { makeWebHandler } from "./http.js";
import type { RuntimeEnv } from "./platform/cloudflare.js";
import { renderPage } from "../web/src/entry.server.js";

const handlers = new WeakMap<RuntimeEnv, ReturnType<typeof makeWebHandler>>();

const handlerFor = (env: RuntimeEnv) => {
  const existing = handlers.get(env);
  if (existing) return existing;
  const handler = makeWebHandler(env);
  handlers.set(env, handler);
  return handler;
};

const isPageRequest = (request: Request): boolean => {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const pathname = new URL(request.url).pathname;
  return pathname === "/" || pathname === "/setup";
};

const renderResponse = async (
  request: Request,
  env: RuntimeEnv,
  handler: (request: Request) => Promise<Response>,
): Promise<Response> => {
  if (env.ASSETS === undefined)
    return new Response("Static assets are unavailable", { status: 503 });
  try {
    const templateResponse = await env.ASSETS.fetch(new URL("/index.html", request.url));
    if (!templateResponse.ok) return templateResponse;
    const template = await templateResponse.text();
    if (!template.includes('<div id="root"></div>'))
      return new Response(template, {
        status: templateResponse.status,
        statusText: templateResponse.statusText,
        headers: templateResponse.headers,
      });
    const result = await renderPage(request, handler);
    return Server.toResponse(template, result);
  } catch (cause) {
    console.error("SKIT server rendering failed", cause);
    return new Response("Server rendering failed", { status: 500 });
  }
};

export default {
  fetch: (request, env) => {
    const handler = handlerFor(env).handler;
    return isPageRequest(request) ? renderResponse(request, env, handler) : handler(request);
  },
} satisfies ExportedHandler<RuntimeEnv>;
