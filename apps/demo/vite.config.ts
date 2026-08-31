import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * The model the demo asks for when nothing overrides it.
 *
 * A *router* over whatever free models exist right now, not one model id. The
 * previous default, `stealth/ox-alpha`, was retired from OpenRouter and every
 * AI feature here began failing against a model that no longer existed — a dead
 * constant nothing could catch, because the id stayed perfectly valid-looking.
 */
const DEFAULT_MODEL = "openrouter/free";

const REPO_ROOT = resolve(HERE, "..", "..");

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
/** Reasoning model: too small a cap comes back with `content: null` (11 §3.6). */
const MAX_TOKENS = 32000;

/**
 * How long a single generation may take, and how long it may go quiet.
 *
 * The first number used to be 240s, and that was the wrong shape of limit: the
 * time a reasoning model needs is proportional to how much code it writes, so a
 * wall-clock cap punishes exactly the request this demo exists for ("build me a
 * complex flow"). QA measured 236s for a 20-node flow — one second under the
 * old ceiling — and two clean timeouts on the ten-requirement prompt, which the
 * same model answered correctly the moment it was told to be terse. The model
 * could do it; the budget could not.
 *
 * So the wall clock moves to 15 minutes and the *useful* limit becomes silence:
 * with `stream: true` tokens arrive continuously, and a stream that stops
 * producing for `STALL_MS` is genuinely dead rather than merely slow.
 */
const TIMEOUT_MS = 900_000;
const STALL_MS = 180_000;

/**
 * Dev-only proxy for the AI chat panel.
 *
 * The API key is read from the repo-root `.env` **in the Vite server process**
 * and never leaves it: the browser posts messages to `/api/ai`, this middleware
 * adds the credential, the model and the token budget, and hands the answer
 * back. Nothing about the key reaches the bundle.
 */
function aiProxy(env: Record<string, string>): Plugin {
  const apiKey = env["OPENROUTER_API_KEY"] ?? "";
  const model = env["OPENROUTER_MODEL"] ?? DEFAULT_MODEL;

  return {
    name: "codeflow:ai-proxy",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/api/ai/status", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            configured: apiKey.length > 0,
            model,
            maxTokens: MAX_TOKENS,
            streaming: true,
            timeoutMs: TIMEOUT_MS,
            stallMs: STALL_MS,
          }),
        );
      });

      server.middlewares.use("/api/ai", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: "POST only" }));
          return;
        }
        res.setHeader("Content-Type", "application/json");

        if (apiKey.length === 0) {
          res.statusCode = 503;
          res.end(
            JSON.stringify({
              error:
                "No OPENROUTER_API_KEY in the repo-root .env — add one and restart the dev server.",
            }),
          );
          return;
        }

        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          void (async () => {
            const started = Date.now();
            const controller = new AbortController();
            let stallTimer: NodeJS.Timeout | null = null;
            let reason: "wall-clock" | "stall" | null = null;
            const wallClock = setTimeout(() => {
              reason = "wall-clock";
              controller.abort();
            }, TIMEOUT_MS);
            /** Restarted on every byte from upstream — see STALL_MS. */
            const beat = (): void => {
              if (stallTimer !== null) clearTimeout(stallTimer);
              stallTimer = setTimeout(() => {
                reason = "stall";
                controller.abort();
              }, STALL_MS);
            };

            /** True once SSE headers went out and errors can no longer be JSON. */
            let streaming = false;
            const sse = (payload: unknown): void => {
              res.write(`data: ${JSON.stringify(payload)}\n\n`);
            };
            const fail = (message: string, status: number): void => {
              if (streaming) {
                sse({ error: message });
                res.end();
                return;
              }
              res.statusCode = status;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: message }));
            };

            // The client aborting (Stop, or a closed tab) must stop the upstream
            // call too — otherwise a 10-minute generation keeps burning quota
            // for a page that is gone.
            res.on("close", () => { if (!res.writableEnded) controller.abort(); });

            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                messages?: unknown;
                maxTokens?: number;
                stream?: boolean;
              };
              if (!Array.isArray(body.messages) || body.messages.length === 0) {
                fail("messages[] is required", 400);
                return;
              }
              const wantsStream = body.stream !== false;

              /**
               * A shared free model is rate-limited often enough that one 429
               * must not read as "the feature is broken". Same policy as the
               * conformance eval: retry 429/5xx with a growing wait, give up
               * out loud after that. Only the *handshake* is retried — once
               * tokens are flowing the answer is already half-written.
               */
              let upstream: Response | null = null;
              let text = "";
              let status = 0;
              for (let attempt = 1; attempt <= 3; attempt++) {
                beat();
                upstream = await fetch(ENDPOINT, {
                  method: "POST",
                  signal: controller.signal,
                  headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                    "HTTP-Referer": "http://localhost:5173",
                    "X-Title": "CodeFlow demo chat",
                  },
                  body: JSON.stringify({
                    model,
                    max_tokens: Math.max(body.maxTokens ?? MAX_TOKENS, MAX_TOKENS),
                    messages: body.messages,
                    ...(wantsStream ? { stream: true } : {}),
                  }),
                });
                status = upstream.status;
                if (status === 200) break;
                text = await upstream.text();
                const retriable = status === 429 || status >= 500 || text.includes('"code":429');
                if (!retriable || attempt === 3) break;
                await new Promise((resolve) => { setTimeout(resolve, 3000 * attempt); });
              }

              if (upstream === null || status !== 200) {
                fail(`OpenRouter ${String(status)}: ${text.slice(0, 300)}`, status === 0 ? 502 : status);
                return;
              }

              /* --- non-streaming: unchanged shape, for callers that ask ---- */
              if (!wantsStream || upstream.body === null) {
                const payload = JSON.parse(await upstream.text()) as {
                  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
                  usage?: unknown;
                  error?: { message?: string };
                };
                if (payload.error !== undefined) {
                  fail(payload.error.message ?? "upstream error", 502);
                  return;
                }
                const choice = payload.choices?.[0];
                res.end(
                  JSON.stringify({
                    content: choice?.message?.content ?? "",
                    finishReason: choice?.finish_reason ?? null,
                    usage: payload.usage ?? null,
                    model,
                    ms: Date.now() - started,
                  }),
                );
                return;
              }

              /* --- streaming ------------------------------------------------
               * Upstream SSE in, one normalized SSE out. The browser gets text
               * as it is written instead of a five-minute spinner, and this
               * middleware never buffers a whole answer in memory.
               */
              streaming = true;
              res.statusCode = 200;
              res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
              res.setHeader("Cache-Control", "no-cache, no-transform");
              res.setHeader("Connection", "keep-alive");
              res.setHeader("X-Accel-Buffering", "no");
              res.flushHeaders?.();
              sse({ start: true, model });

              const decoder = new TextDecoder();
              let buffer = "";
              let content = "";
              let finishReason: string | null = null;
              // A reasoning model is silent for minutes before its first word of
              // answer, but it is not idle — it is emitting reasoning tokens.
              // Forwarding their volume is what lets the panel say "still
              // thinking, and here is the proof" instead of nothing at all.
              let reasoning = 0;
              let reportedReasoning = 0;

              const reader = upstream.body.getReader();
              for (;;) {
                const step = await reader.read();
                if (step.done) break;
                beat();
                buffer += decoder.decode(step.value, { stream: true });
                let cut = buffer.indexOf("\n\n");
                while (cut !== -1) {
                  const frame = buffer.slice(0, cut);
                  buffer = buffer.slice(cut + 2);
                  cut = buffer.indexOf("\n\n");

                  for (const line of frame.split("\n")) {
                    // OpenRouter sends `: OPENROUTER PROCESSING` comments while
                    // a reasoning model thinks — that is the keep-alive, and it
                    // is what makes the stall timer meaningful.
                    if (!line.startsWith("data:")) continue;
                    const data = line.slice(5).trim();
                    if (data === "[DONE]" || data.length === 0) continue;
                    let parsed: {
                      choices?: {
                        delta?: { content?: string | null; reasoning?: string | null };
                        finish_reason?: string | null;
                      }[];
                      error?: { message?: string };
                    };
                    try {
                      parsed = JSON.parse(data) as typeof parsed;
                    } catch {
                      continue;
                    }
                    if (parsed.error !== undefined) {
                      fail(parsed.error.message ?? "upstream error", 502);
                      return;
                    }
                    const choice = parsed.choices?.[0];
                    const delta = choice?.delta?.content ?? "";
                    if (choice?.finish_reason != null) finishReason = choice.finish_reason;
                    reasoning += (choice?.delta?.reasoning ?? "").length;
                    if (delta.length > 0) {
                      content += delta;
                      sse({ delta });
                    } else if (reasoning - reportedReasoning >= 400) {
                      reportedReasoning = reasoning;
                      sse({ thinking: reasoning });
                    }
                  }
                }
              }

              sse({ done: true, finishReason, model, ms: Date.now() - started, length: content.length });
              res.end();
            } catch (cause) {
              const aborted = cause instanceof Error && cause.name === "AbortError";
              const seconds = (ms: number): string => String(Math.round(ms / 1000));
              fail(
                aborted
                  ? reason === "stall"
                    ? `The model went quiet for ${seconds(STALL_MS)}s and the request was dropped.`
                    : reason === "wall-clock"
                      ? `The model was still writing after ${seconds(TIMEOUT_MS)}s, which is past this demo's ceiling.`
                      : "Stopped."
                  : cause instanceof Error
                    ? cause.message
                    : String(cause),
                504,
              );
            } finally {
              clearTimeout(wallClock);
              if (stallTimer !== null) clearTimeout(stallTimer);
            }
          })();
        });
      });
    },
  };
}

export default defineConfig(async ({ command, mode }) => {
  // No prefix filter: OPENROUTER_* is a server-side secret and must never be
  // exposed through `import.meta.env`, so it is read here and used here only.
  const env = loadEnv(mode, REPO_ROOT, "");

  /*
   * The server-shaped plugins are imported at *runtime*, not bundled into this
   * config, and only when there is a server to configure.
   *
   * Vite loads a TypeScript config by pre-bundling it with esbuild, which would
   * pull `server/**` into that bundle along with `typescript` and the MCP SDK.
   * A dynamic import keeps the whole runner in Node's own module graph, where
   * its `.ts` files are type-stripped natively and `new Worker("…/worker.ts")`
   * resolves to a file that actually exists.
   *
   * Guarded by `command === "serve"` because native type stripping is Node
   * 22.18+/23.6+, and on Node 20 the import fails with a bare
   * ERR_UNKNOWN_FILE_EXTENSION that takes the whole build down. Both plugins
   * are `configureServer`-only — they add two dev endpoints and have no build
   * hooks — so a production build never wanted them, and skipping it makes
   * `vite build` work everywhere the published packages do. It also stops the
   * static bundle's "the runner is not available here" story from depending on
   * an import that merely happened not to matter.
   */
  // `command === "serve"` alone is not the condition: Vitest resolves this very
  // config with `command: "serve"` too, so a test run would load the dev
  // endpoints it never calls — and fail on Node 20 before a single test ran.
  // The demo's tests import `server/*` directly; nothing there needs the
  // middleware to be registered.
  const serverPlugins: Plugin[] = [];
  if (command === "serve" && process.env["VITEST"] === undefined) {
    const { runPlugin } = (await import(
      new URL("./server/run-plugin.ts", import.meta.url).href
    )) as typeof import("./server/run-plugin.js");

    // Same reason, same shape: `/api/mcp/discover` owns the MCP SDK's
    // transports, which is what lets a visitor point the demo at a server of
    // their own.
    const { mcpPlugin } = (await import(
      new URL("./server/mcp-discover.ts", import.meta.url).href
    )) as typeof import("./server/mcp-discover.js");

    serverPlugins.push(runPlugin({ appDir: HERE }) as Plugin, mcpPlugin() as Plugin);
  }

  return {
    plugins: [react(), tailwindcss(), aiProxy(env), ...serverPlugins],
    server: { port: 5173, strictPort: true },
    build: {
      // Monaco is large; the demo is a dev harness, not a shipped bundle.
      chunkSizeWarningLimit: 4096,
    },
  };
});
