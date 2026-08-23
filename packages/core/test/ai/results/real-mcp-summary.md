# Real-MCP AI conformance — stealth/ox-alpha

Registry: **24 tools** captured from real MCP servers (filesystem, memory, sequential-thinking). Eval version 1. System prompt ≈ 4567 tokens, `max_tokens` 32000.

Ran 2026-08-23T02:26:53.236Z · 4 generations · max 2 retries.

| Level | Reached | Rate |
| --- | --- | --- |
| L0 (parses + typechecks) | 3/4 | 75% |
| L1 (analyzes to a graph) | 3/4 | 75% |
| L2 (idiomatic) | 2/4 | 50% |

## Per intent

| Intent | First | Final | Retries | Real tools called |
| --- | --- | --- | --- | --- |
| index-directory-into-memory | invalid | invalid | 2 | `filesystem.listDirectory`, `filesystem.readTextFile`, `memory.createEntities` |
| search-and-report | L2 | L2 | 0 | `filesystem.searchFiles`, `filesystem.writeFile` |
| resilient-edit | L1 | L1 | 0 | `filesystem.editFile`, `filesystem.readTextFile`, `filesystem.writeFile` |
| think-then-act | L2 | L2 | 0 | `filesystem.readTextFile`, `memory.addObservations`, `sequentialThinking.sequentialthinking` |

## index-directory-into-memory

### round 0 → invalid (45533ms)

Diagnostics:

- `parse-error` Unterminated string literal. The file must be valid TypeScript before anything else can be checked (10 §5).
- `parse-error` ',' expected. The file must be valid TypeScript before anything else can be checked (10 §5).
- `parse-error` Unterminated string literal. The file must be valid TypeScript before anything else can be checked (10 §5).
- `parse-error` ')' expected. The file must be valid TypeScript before anything else can be checked (10 §5).

```ts
import type { Tools } from "../generated/tools";

function parseFileNames(listing: string): string[] {
  return listing
    .split("
")
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

  for (const fileName of fileNames) {
    const filePath = `${input.directory}/${fileName}`;
    const fileContents = await tools.filesystem.readTextFile({ path: filePath });

    await tools.memory.createEntities({
      entities: [
        {
          name: filePath,
          entityType: "file",
          observations: [fileContents.content],
        },
      ],
    });
  }

  return { directory: input.directory, recordedFiles: fileNames.length };
}
```

### round 1 → invalid (31163ms)

Diagnostics:

- `parse-error` Unterminated string literal. The file must be valid TypeScript before anything else can be checked (10 §5).
- `parse-error` ',' expected. The file must be valid TypeScript before anything else can be checked (10 §5).
- `parse-error` Unterminated string literal. The file must be valid TypeScript before anything else can be checked (10 §5).
- `parse-error` ')' expected. The file must be valid TypeScript before anything else can be checked (10 §5).

```ts
import type { Tools } from "../generated/tools";

function parseFileNames(listing: string): string[] {
  return listing
    .split("
")
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

  for (const fileName of fileNames) {
    const filePath = `${input.directory}/${fileName}`;
    const fileContents = await tools.filesystem.readTextFile({ path: filePath });

    await tools.memory.createEntities({
      entities: [
        {
          name: filePath,
          entityType: "file",
          observations: [fileContents.content],
        },
      ],
    });
  }

  return { directory: input.directory, recordedFiles: fileNames.length };
}
```

### round 2 → invalid (52075ms)

Diagnostics:

- `parse-error` Unterminated string literal. The file must be valid TypeScript before anything else can be checked (10 §5).
- `parse-error` ',' expected. The file must be valid TypeScript before anything else can be checked (10 §5).
- `parse-error` Unterminated string literal. The file must be valid TypeScript before anything else can be checked (10 §5).
- `parse-error` ')' expected. The file must be valid TypeScript before anything else can be checked (10 §5).

```ts
import type { Tools } from "../generated/tools";

function parseFileNames(listing: string): string[] {
  return listing
    .split("
")
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

  for (const fileName of fileNames) {
    const filePath = `${input.directory}/${fileName}`;
    const fileContents = await tools.filesystem.readTextFile({ path: filePath });

    await tools.memory.createEntities({
      entities: [
        {
          name: filePath,
          entityType: "file",
          observations: [fileContents.content],
        },
      ],
    });
  }

  return { directory: input.directory, recordedFiles: fileNames.length };
}
```

## search-and-report

### round 0 → L2 (58184ms)

```ts
import type { Tools } from "../generated/tools";

export default async function flow(
  input: { directory: string; pattern: string },
  tools: Tools
) {
  const searchResult = await tools.filesystem.searchFiles({
    path: input.directory,
    pattern: input.pattern,
  });

  const matches = parseMatches(searchResult.content);

  if (matches.length === 0) {
    const noMatchWrite = await tools.filesystem.writeFile({
      path: `${input.directory}/report.txt`,
      content: "No files matched the given pattern.",
    });
    return {
      found: false,
      reportPath: `${input.directory}/report.txt`,
      result: noMatchWrite,
    };
  }

  const reportContent = formatReport(input.pattern, matches);
  const reportWrite = await tools.filesystem.writeFile({
    path: `${input.directory}/report.txt`,
    content: reportContent,
  });

  return {
    found: true,
    matchCount: matches.length,
    reportPath: `${input.directory}/report.txt`,
    result: reportWrite,
  };
}

function parseMatches(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function formatReport(pattern: string, matches: string[]): string {
  const lines = [
    `Search pattern: ${pattern}`,
    `Matches found: ${matches.length}`,
    "",
    ...matches.map((match) => `- ${match}`),
  ];
  return lines.join("\n");
}
```

## resilient-edit

### round 0 → L1 (79198ms)

Diagnostics:

- `unsupported-construct` Custom code is kept verbatim — no semantic projection.
- `unsupported-construct` Custom code is kept verbatim — no semantic projection.
- `unsupported-construct` Custom code is kept verbatim — no semantic projection.
- `unsupported-construct` Custom code is kept verbatim — no semantic projection.
- `unsupported-construct` Custom code is kept verbatim — no semantic projection.
- `unsupported-construct` Custom code is kept verbatim — no semantic projection.
- `unsupported-construct` Custom code is kept verbatim — no semantic projection.
- `inline-logic-in-code-node` `String(error)` runs inside a custom code node, so the step is invisible on the graph. Give the call its own `const x = await …` statement if it is a tool, or move the logic into a named function and call that (01 §3 rules 4–5).

```ts
import type { Tools } from "../generated/tools";

export default async function flow(
  input: { path: string },
  tools: Tools
) {
  let succeeded = false;
  let failureReason = "";

  try {
    await tools.filesystem.editFile({
      path: input.path,
      edits: [{ oldText: "TODO", newText: "DONE" }],
    });
    succeeded = true;
  } catch (error) {
    failureReason = String(error);
  }

  if (!succeeded) {
    let previousLog = "";
    try {
      const currentLog = await tools.filesystem.readTextFile({ path: "errors.log" });
      previousLog = currentLog.content;
    } catch {
      previousLog = "";
    }
    const newLogContent = `${previousLog}Failed to replace TODO with DONE in ${input.path}: ${failureReason}\n`;
    await tools.filesystem.writeFile({ path: "errors.log", content: newLogContent });
  }

  return { succeeded };
}
```

## think-then-act

### round 0 → L2 (102768ms)

```ts
import type { Tools } from "../generated/tools";

export default async function flow(
  input: { readmePath: string; repository: string },
  tools: Tools
) {
  const openingThought = await tools.sequentialThinking.sequentialthinking({
    thought: `Planning how to summarise the repository "${input.repository}". Step 1 of the plan: read the README at the documented path and extract its purpose, key features, and setup instructions.`,
    nextThoughtNeeded: true,
    thoughtNumber: 1,
    totalThoughts: 3
  });

  const structureThought = await tools.sequentialThinking.sequentialthinking({
    thought: `Step 2 of the plan: complement the README with the repository layout — top-level directories, configuration files, and entry points — so the summary covers structure and tooling, not just prose.`,
    nextThoughtNeeded: true,
    thoughtNumber: 2,
    totalThoughts: 3
  });

  const finalPlanThought = await tools.sequentialThinking.sequentialthinking({
    thought: `Step 3 of the plan: merge the README findings and the structural notes into a concise summary (purpose, architecture, setup, usage) and record it as an observation on the knowledge-graph entity "${input.repository}". Plan complete.`,
    nextThoughtNeeded: false,
    thoughtNumber: 3,
    totalThoughts: 3
  });

  const readme = await tools.filesystem.readTextFile({ path: input.readmePath });

  const recorded = await tools.memory.addObservations({
    observations: [
      {
        entityName: input.repository,
        contents: [
          `Repository summary plan for "${input.repository}": (1) read the README (${input.readmePath}) for purpose, features and setup; (2) review the top-level layout and config files for structure and tooling; (3) merge both into a concise summary.`
        ]
      }
    ]
  });

  return {
    repository: input.repository,
    planThoughts: [
      openingThought.thoughtNumber,
      structureThought.thoughtNumber,
      finalPlanThought.thoughtNumber
    ],
    readmeChars: readme.content.length,
    recorded
  };
}
```

