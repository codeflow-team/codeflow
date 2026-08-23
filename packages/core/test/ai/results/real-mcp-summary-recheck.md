# Real-MCP AI conformance — stealth/ox-alpha

Registry: **24 tools** captured from real MCP servers (filesystem, memory, sequential-thinking). Eval version 1. System prompt ≈ 4567 tokens, `max_tokens` 32000.

Ran 2026-08-23T02:29:31.615Z · 2 generations · max 2 retries.

| Level | Reached | Rate |
| --- | --- | --- |
| L0 (parses + typechecks) | 2/2 | 100% |
| L1 (analyzes to a graph) | 2/2 | 100% |
| L2 (idiomatic) | 1/2 | 50% |

## Per intent

| Intent | First | Final | Retries | Real tools called |
| --- | --- | --- | --- | --- |
| index-directory-into-memory | L2 | L2 | 0 | `filesystem.listDirectory`, `filesystem.readTextFile`, `memory.createEntities` |
| index-directory-into-memory | L1 | L1 | 0 | `filesystem.listDirectory`, `filesystem.readTextFile`, `memory.createEntities` |

## index-directory-into-memory

### round 0 → L2 (53748ms)

```ts
import type { Tools } from "../generated/tools";

export default async function flow(
  input: { directory: string },
  tools: Tools
) {
  const listing = await tools.filesystem.listDirectory({ path: input.directory });

  const fileNames = extractFileNames(listing.content);

  for (const fileName of fileNames) {
    const filePath = joinPath(input.directory, fileName);

    const contents = await tools.filesystem.readTextFile({ path: filePath });

    await tools.memory.createEntities({
      entities: [
        {
          name: filePath,
          entityType: "file",
          observations: [contents.content]
        }
      ]
    });
  }

  return { recordedFiles: fileNames.length };
}

function extractFileNames(listing: string): string[] {
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("[FILE]"))
    .map((line) => line.slice("[FILE]".length).trim());
}

function joinPath(directory: string, fileName: string): string {
  return `${directory}/${fileName}`;
}
```

## index-directory-into-memory

### round 0 → L1 (70108ms)

Diagnostics:

- `unsupported-construct` Custom code is kept verbatim — no semantic projection.
- `unsupported-construct` Custom code is kept verbatim — no semantic projection.
- `unsupported-construct` Custom code is kept verbatim — no semantic projection.
- `inline-logic-in-code-node` `recordedFiles.push(filePath)` runs inside a custom code node, so the step is invisible on the graph. Give the call its own `const x = await …` statement if it is a tool, or move the logic into a named function and call that (01 §3 rules 4–5).

```ts
import type { Tools } from "../generated/tools";

/** Extract file names from a listDirectory listing (lines prefixed with [FILE] / [DIR]). */
function parseFileNames(listing: string): string[] {
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("[FILE]"))
    .map((line) => line.slice("[FILE]".length).trim());
}

export default async function flow(
  input: { directory: string },
  tools: Tools
) {
  const listing = await tools.filesystem.listDirectory({ path: input.directory });
  const fileNames = parseFileNames(listing.content);

  const recordedFiles: string[] = [];

  for (const fileName of fileNames) {
    const filePath = `${input.directory}/${fileName}`;
    const contents = await tools.filesystem.readTextFile({ path: filePath });
    await tools.memory.createEntities({
      entities: [
        {
          name: filePath,
          entityType: "file",
          observations: [contents.content],
        },
      ],
    });
    recordedFiles.push(filePath);
  }

  return { recordedFiles };
}
```

