/**
 * duckduckgo — 1 tools, GENERATED. Do not edit by hand.
 *
 * Source: `packages/mcp/test/real-schemas/duckduckgo.json` (a verbatim
 * `tools/list` payload from the real server), run through
 * `mcpToolsToDefinitions` with namespace `"search"`.
 * Regenerate with `pnpm --filter @codeflow-team/examples embed`.
 */

import type { ToolDefinition } from "@codeflow-team/core";

export const DUCKDUCKGO_TOOLS: ToolDefinition[] = [
    {
      "name": "search.webSearch",
      "label": "Duckduckgo Web Search",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Search query (max 400 chars)",
            "maxLength": 400
          },
          "count": {
            "type": "number",
            "description": "Number of results (1-20, default 10)",
            "minimum": 1,
            "maximum": 20,
            "default": 10
          },
          "safeSearch": {
            "type": "string",
            "description": "SafeSearch level (strict, moderate, off)",
            "enum": [
              "strict",
              "moderate",
              "off"
            ],
            "default": "moderate"
          }
        },
        "required": [
          "query"
        ]
      },
      "description": "Performs a web search using the DuckDuckGo, ideal for general queries, news, articles, and online content. Use this for broad information gathering, recent events, or when you need diverse web sources. Supports content filtering and region-specific searches. Maximum 20 results per request.",
      "editableFields": [
        "query",
        "count",
        "safeSearch"
      ]
    }
  ];
