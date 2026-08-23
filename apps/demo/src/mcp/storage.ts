/**
 * Where the MCP server list lives between visits.
 *
 * `localStorage`, not `sessionStorage` (which is what `persist.ts` uses for the
 * scratch flow): a configured server is a *setting*, not a scratch pad. Someone
 * who wired their own server to the demo should find it there tomorrow.
 *
 * ## Tokens
 *
 * A remote server may need a header (`Authorization: Bearer …`). Writing that
 * to `localStorage` puts a live credential in plain text on disk, readable by
 * any script that ever runs on this origin. So the default is **not to**: the
 * value is held in a module-level map for the life of the tab and asked for
 * again after a reload. A visitor who prefers the convenience can tick
 * "remember", and the UI says in the same breath what that means — 07 §5's rule
 * about never hiding what a control actually does applies to security copy
 * first of all.
 */

import type { McpServerConfig } from "./model.js";

const KEY = "codeflow.demo.mcp-servers.v1";
const ACK_KEY = "codeflow.demo.mcp-stdio-ack.v1";

/** Tokens the user did not ask to persist. Lost when the tab closes. */
const sessionTokens = new Map<string, string>();

export function tokenFor(config: McpServerConfig): string | undefined {
  if (config.rememberToken === true) return config.headerValue;
  return sessionTokens.get(config.id);
}

export function setSessionToken(id: string, value: string): void {
  if (value.length === 0) sessionTokens.delete(id);
  else sessionTokens.set(id, value);
}

export function forgetSessionToken(id: string): void {
  sessionTokens.delete(id);
}

/** What actually gets written: the token is stripped unless it was opted into. */
function forStorage(configs: readonly McpServerConfig[]): McpServerConfig[] {
  return configs.map((config) => {
    if (config.rememberToken === true) return config;
    const { headerValue: _dropped, ...rest } = config;
    return rest;
  });
}

export function loadServers(): McpServerConfig[] | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(isConfig);
  } catch {
    // Private mode, a quota error, or a payload from an older build. A broken
    // setting must not be a broken app.
    return null;
  }
}

export interface SaveResult {
  ok: boolean;
  error?: string;
}

export function saveServers(configs: readonly McpServerConfig[]): SaveResult {
  try {
    localStorage.setItem(KEY, JSON.stringify(forStorage(configs)));
    return { ok: true };
  } catch (cause) {
    // A discovered registry carries every tool's JSON Schema, and a 60-tool
    // server is not small. Saying so beats a silent forget.
    return {
      ok: false,
      error:
        cause instanceof Error && /quota/i.test(cause.message)
          ? "This browser's storage is full, so the server list was not saved. Remove a server, or deselect some tools."
          : "The server list could not be saved in this browser, so it will be gone after a reload.",
    };
  }
}

export function clearServers(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing sensible to do */
  }
  sessionTokens.clear();
}

/** Has the user been shown, and accepted, the "this runs on your machine" warning? */
export function stdioAcknowledged(): boolean {
  try {
    return localStorage.getItem(ACK_KEY) === "1";
  } catch {
    return false;
  }
}

export function acknowledgeStdio(): void {
  try {
    localStorage.setItem(ACK_KEY, "1");
  } catch {
    /* the warning simply shows again next time, which is the safe direction */
  }
}

function isConfig(value: unknown): value is McpServerConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["id"] === "string" &&
    typeof candidate["name"] === "string" &&
    typeof candidate["namespace"] === "string" &&
    (candidate["transport"] === "stdio" || candidate["transport"] === "http" || candidate["transport"] === "sse")
  );
}
