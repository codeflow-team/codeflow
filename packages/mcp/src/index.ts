/**
 * @codeflow/mcp — optional MCP adapter (05-registry.md §3).
 *
 * TODO (phase 5, per build order 08 §2): MCP server tool discovery → ToolDefinition
 * (JSON Schema maps almost 1:1) → registry → codegen. Later: expose CodeFlow itself
 * as an MCP server (resource `codeflow://context`, tool `codeflow.validate`),
 * 10-ai-codegen.md §3.
 *
 * Core never depends on MCP; this adapter is optional by design.
 */

export {};
