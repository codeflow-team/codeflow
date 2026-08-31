/**
 * `POST /api/run` — the demo's execution endpoint.
 *
 * ## Why it lives here and not in the library
 *
 * `@codeflow-team/core` must never execute a flow: that is non-goal #1 (00 §5) and
 * invariant I7 (11-testing.md), and `packages/core/test/no-execution.test.ts`
 * fails loudly if anyone changes their mind. Execution belongs to a runtime
 * (09 §1), and the *demo* needs one to show what tracing is for — so the demo
 * has one, in its own dev server, next to the AI proxy that is already here for
 * the same reason: a thing the browser cannot do, done on the Node side.
 *
 * Core's whole contribution is the contract — `RunEvent` and `nodeRanges`, both
 * in `packages/core/src/run/`. The browser reads the ranges off the graph it
 * already has and posts them here; this endpoint runs the code and posts back
 * events. Neither side needs the other's internals.
 *
 * ## Flushing is the feature
 *
 * Every frame is written and flushed the moment it arrives, and nothing is
 * batched anywhere on the path (`runner.ts` emits synchronously, this writes
 * synchronously, `Cache-Control: no-transform` and `X-Accel-Buffering: no` warn
 * off anything in between). A trace delivered at the end would light every node
 * up at once, and "which step is running" would be a thing the UI claims rather
 * than shows.
 */

import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describeTriggerInput } from "./input-shape.ts";
import { RUNNABLE_SERVERS } from "./mcp-servers.ts";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  startRun,
  type RunFrame,
  type RunRequest,
} from "./runner.ts";

export interface RunPluginOptions {
  /** Absolute path of `apps/demo` — the worker entry is resolved against it. */
  appDir: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => { resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

type Middleware = (req: IncomingMessage, res: ServerResponse) => void;

export function runPlugin(options: RunPluginOptions): {
  name: string;
  configureServer: (server: { middlewares: { use: (path: string, handler: Middleware) => void } }) => void;
} {
  const workerEntry = join(options.appDir, "server", "worker.ts");

  return {
    name: "codeflow:run",
    configureServer(server) {
      server.middlewares.use("/api/run/status", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            available: true,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
            maxTimeoutMs: MAX_TIMEOUT_MS,
            /** Namespaces that get a real server — the UI badges them "live". */
            realServers: RUNNABLE_SERVERS.map((plan) => ({
              namespace: plan.namespace,
              server: plan.server,
              safety: plan.safety,
            })),
            note:
              "Demo runner: a worker thread on the dev server, killable and credential-free. " +
              "Not a sandbox — a real deployment must isolate execution (09 §1).",
          }),
        );
      });

      /*
       * What the trigger takes, and what a run would start from.
       *
       * The synthesis rules and the type reader both need the TypeScript
       * parser and both belong to `input.ts`'s story, so the browser asks
       * rather than keeping a second copy of either. Registered before
       * `/api/run` because connect matches by prefix.
       */
      server.middlewares.use("/api/run/input", (req, res) => {
        res.setHeader("Content-Type", "application/json");
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: "POST only" }));
          return;
        }
        void readBody(req).then(
          (raw) => {
            try {
              const body = JSON.parse(raw) as { source?: unknown };
              if (typeof body.source !== "string") {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "`source` is required." }));
                return;
              }
              res.end(JSON.stringify(describeTriggerInput(body.source)));
            } catch (cause) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }));
            }
          },
          (cause: unknown) => {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }));
          },
        );
      });

      server.middlewares.use("/api/run", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "POST only" }));
          return;
        }
        void handleRun(req, res, workerEntry);
      });
    },
  };
}

async function handleRun(req: IncomingMessage, res: ServerResponse, workerEntry: string): Promise<void> {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (frame: RunFrame | { type: "fatal"; message: string }): void => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
    // No-op on a plain ServerResponse; present if a host ever puts compression
    // in front, which buffers until told otherwise.
    (res as ServerResponse & { flush?: () => void }).flush?.();
  };

  let body: RunRequest;
  try {
    body = JSON.parse(await readBody(req)) as RunRequest;
  } catch (cause) {
    send({ type: "fatal", message: cause instanceof Error ? cause.message : String(cause) });
    res.end();
    return;
  }

  if (typeof body.source !== "string" || body.source.trim().length === 0) {
    send({ type: "fatal", message: "`source` is required." });
    res.end();
    return;
  }

  const keepScratch = /[?&]keep=1(&|$)/.test(req.url ?? "");
  const handle = startRun({ ...body, keepScratch }, workerEntry, send);

  // Stop: the browser aborts the fetch, the socket closes, the worker dies.
  // That is the whole cancel path — no flag anyone can forget to check.
  res.on("close", () => { handle.cancel(); });

  await handle.finished;
  if (!res.writableEnded) res.end();
}
