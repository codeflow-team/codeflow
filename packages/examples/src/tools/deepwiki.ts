/**
 * deepwiki — 1 tools, GENERATED. Do not edit by hand.
 *
 * Source: `packages/mcp/test/real-schemas/deepwiki.json` (a verbatim
 * `tools/list` payload from the real server), run through
 * `mcpToolsToDefinitions` with namespace `"deepwiki"`.
 * Regenerate with `pnpm --filter @codeflow-team/examples embed`.
 */

import type { ToolDefinition } from "@codeflow-team/core";

export const DEEPWIKI_TOOLS: ToolDefinition[] = [
    {
      "name": "deepwiki.fetch",
      "label": "Deepwiki Fetch",
      "inputSchema": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "should be a URL, owner/repo name (e.g. \"vercel/ai\"), a two-word \"owner repo\" form (e.g. \"vercel ai\"), or a single library keyword"
          },
          "maxDepth": {
            "type": "integer",
            "minimum": 0,
            "maximum": 1,
            "default": 1,
            "description": "Can fetch a single site => maxDepth 0 or multiple/all sites => maxDepth 1"
          },
          "mode": {
            "type": "string",
            "enum": [
              "aggregate",
              "pages"
            ],
            "default": "aggregate"
          },
          "verbose": {
            "type": "boolean",
            "default": false
          }
        },
        "required": [
          "url"
        ],
        "additionalProperties": false,
        "$schema": "http://json-schema.org/draft-07/schema#"
      },
      "description": "Fetch a deepwiki.com repo and return Markdown",
      "editableFields": [
        "url",
        "maxDepth",
        "mode",
        "verbose"
      ]
    }
  ];
