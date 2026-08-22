/**
 * codeflow — CLI (02-architecture.md §2, 10-ai-codegen.md §2).
 *
 * Split from core because it needs fs/watch: core must stay browser-safe.
 *
 * TODO (phase 5, per build order 08 §2):
 *  - `codeflow generate`            — write generated/tools.d.ts + generated/lib.d.ts
 *                                     from codeflow.config.ts
 *  - `codeflow check`               — analyze every flow in flows/, report
 *                                     workspace-wide diagnostics (catches breakage
 *                                     when a tool or library function changes)
 *  - `codeflow generate --agent-md` — emit the AGENTS.md/CLAUDE.md section
 *  - default file-based FunctionLibraryStore over the workspace `lib/` directory
 *    (the file IS the storage — no second copy)
 */

export {};
