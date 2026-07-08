import type { ApprovalService } from "./approvals.js";
import type { AutomationRunner } from "./automation-runner.js";
import type { ReloadEventStore } from "./events.js";
import type { TokenService } from "./tokens.js";
import type { Actor, ServerConfig } from "./types.js";

export type AuthMode = "none" | "client" | "host";

export interface RequestContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
  config: ServerConfig;
  approvals: ApprovalService;
  reloadEvents: ReloadEventStore;
  tokens: TokenService;
  automationRunner: AutomationRunner;
  actor?: Actor;
}

export interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  auth: AuthMode;
  handler: (ctx: RequestContext) => Promise<Response>;
}

export type MatchedRoute = Route & {
  params: Record<string, string>;
};

export function matchRoute(routes: Route[], method: string, path: string): MatchedRoute | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = path.match(route.regex);
    if (!match) continue;
    const params: Record<string, string> = {};
    for (let index = 0; index < route.keys.length; index += 1) {
      const key = route.keys[index];
      const value = match[index + 1];
      if (!key || value === undefined) return null;
      params[key] = decodeURIComponent(value);
    }
    return { ...route, params };
  }
  return null;
}

export function addRoute(routes: Route[], method: string, path: string, auth: AuthMode, handler: Route["handler"]): void {
  const keys: string[] = [];
  const regex = pathToRegex(path, keys);
  routes.push({ method, regex, keys, auth, handler });
}

function pathToRegex(path: string, keys: string[]): RegExp {
  const pattern = path.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    keys.push(key);
    return "([^/]+)";
  });
  return new RegExp(`^${pattern}$`);
}
