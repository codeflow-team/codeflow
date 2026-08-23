import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
/** Reasoning model: too small a cap comes back with `content: null` (11 §3.6). */
const MAX_TOKENS = 32000;
const TIMEOUT_MS = 240_000;

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
  const model = env["OPENROUTER_MODEL"] ?? "stealth/ox-alpha";

  return {
    name: "codeflow:ai-proxy",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/api/ai/status", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ configured: apiKey.length > 0, model, maxTokens: MAX_TOKENS }));
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
            const timer = setTimeout(() => { controller.abort(); }, TIMEOUT_MS);
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                messages?: unknown;
                maxTokens?: number;
              };
              if (!Array.isArray(body.messages) || body.messages.length === 0) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "messages[] is required" }));
                return;
              }

              /**
               * A shared free model is rate-limited often enough that one 429
               * must not read as "the feature is broken". Same policy as the
               * conformance eval: retry 429/5xx with a growing wait, give up
               * out loud after that.
               */
              let text = "";
              let status = 0;
              for (let attempt = 1; attempt <= 3; attempt++) {
                const upstream = await fetch(ENDPOINT, {
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
                  }),
                });
                text = await upstream.text();
                status = upstream.status;
                const retriable = status === 429 || status >= 500 || text.includes('"code":429');
                if (!retriable || attempt === 3) break;
                await new Promise((resolve) => { setTimeout(resolve, 3000 * attempt); });
              }

              if (status !== 200) {
                res.statusCode = status;
                res.end(JSON.stringify({ error: `OpenRouter ${String(status)}: ${text.slice(0, 300)}` }));
                return;
              }

              const payload = JSON.parse(text) as {
                choices?: { message?: { content?: string | null }; finish_reason?: string }[];
                usage?: unknown;
                error?: { message?: string };
              };
              if (payload.error !== undefined) {
                res.statusCode = 502;
                res.end(JSON.stringify({ error: payload.error.message ?? "upstream error" }));
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
            } catch (cause) {
              const aborted = cause instanceof Error && cause.name === "AbortError";
              res.statusCode = aborted ? 504 : 500;
              res.end(
                JSON.stringify({
                  error: aborted
                    ? `The model did not answer within ${String(Math.round(TIMEOUT_MS / 1000))}s.`
                    : cause instanceof Error
                      ? cause.message
                      : String(cause),
                }),
              );
            } finally {
              clearTimeout(timer);
            }
          })();
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // No prefix filter: OPENROUTER_* is a server-side secret and must never be
  // exposed through `import.meta.env`, so it is read here and used here only.
  const env = loadEnv(mode, REPO_ROOT, "");
  return {
    plugins: [react(), tailwindcss(), aiProxy(env)],
    server: { port: 5173, strictPort: true },
    build: {
      // Monaco is large; the demo is a dev harness, not a shipped bundle.
      chunkSizeWarningLimit: 4096,
    },
  };
});
