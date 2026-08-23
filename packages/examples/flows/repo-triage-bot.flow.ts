import type { Tools } from "../generated/tools";
import { isSourcePath, renderTriageReport, scoreRisk } from "@flows/lib";

/**
 * Repo triage bot — filesystem + memory MCP.
 *
 * Walks every root it is allowed to read, scores the source files it finds,
 * remembers what it learned in the knowledge graph, and writes a markdown
 * report back into the repository. Everything it touches is a real tool from
 * `@modelcontextprotocol/server-filesystem` and `@modelcontextprotocol/server-memory`.
 */

interface Finding {
  path: string;
  level: string;
  score: number;
  reasons: string[];
}

export default async function flow(
  input: {
    repository: string;
    roots: string[];
    maxFiles: number;
    reportPath: string;
    escalateChannel: string;
  },
  tools: Tools
) {
  /* ---------------------------------------------------------------- */
  /* 0 — preflight: what are we even allowed to look at?               */
  /* ---------------------------------------------------------------- */

  const permitted = await tools.fs.listAllowedDirectories({});

  // Plumbing, not a step: parsing a tool's text output into a list.
  const allowedRoots = permitted.content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (allowedRoots.length === 0) {
    return { repository: input.repository, status: "no-access", findings: [] as Finding[] };
  }

  if (input.roots.length === 0) {
    return { repository: input.repository, status: "nothing-requested", findings: [] as Finding[] };
  }

  const memoryBefore = await tools.memory.searchNodes({ query: input.repository });

  // `entries` at flow scope — deliberately shadowed inside the loop below, so
  // the data edges have to resolve by binding rather than by name.
  const entries = memoryBefore.entities.map((entity) => entity.name);

  await tools.memory.createEntities({
    entities: [
      {
        name: input.repository,
        entityType: "repository",
        observations: [
          `triage started with ${input.roots.length} root(s)`,
          `knowledge graph already held ${entries.length} entities`
        ]
      }
    ]
  });

  /* ---------------------------------------------------------------- */
  /* 1 — the scan: three nested loops inside one outer try             */
  /* ---------------------------------------------------------------- */

  const findings: Finding[] = [];

  // Written from four different places: the declaration and three branches.
  let scanned = 0;
  let skipped = 0;
  let escalations = "";

  try {
    outer: for (const root of input.roots) {
      const reachable = allowedRoots.some((allowed) => root.startsWith(allowed));

      if (!reachable) {
        skipped = skipped + 1;
        continue outer;
      }

      const tree = await tools.fs.directoryTree({
        path: root,
        excludePatterns: ["node_modules", "dist", ".git", "coverage"]
      });

      // Directory listing → the directories worth descending into.
      const directories = tree.content
        .split("\n")
        .filter((line) => line.trim().endsWith("/"))
        .map((line) => `${root}/${line.trim().replace(/\/$/, "")}`);

      for (const directory of directories) {
        const listing = await tools.fs.listDirectoryWithSizes({
          path: directory,
          sortBy: "size"
        });

        // Shadows the flow-scope `entries` — a different binding, same name.
        const entries = listing.content
          .split("\n")
          .map((line) => line.replace(/^\[(FILE|DIR)\]\s*/, "").trim())
          .filter((line) => line.length > 0);

        for (const entry of entries) {
          if (scanned >= input.maxFiles) {
            break outer;
          }

          const candidate = `${directory}/${entry}`;

          if (!isSourcePath(candidate)) {
            skipped = skipped + 1;
            continue;
          }

          /* --- try inside a loop inside a loop inside a loop inside a try --- */
          try {
            const stat = await tools.fs.getFileInfo({ path: candidate });

            if (stat.content.includes("size: 0")) {
              skipped = skipped + 1;
              continue;
            }

            const file = await tools.fs.readTextFile({ path: candidate, head: 400 });

            scanned = scanned + 1;

            const verdict = scoreRisk(candidate, file.content);

            if (verdict.level === "high") {
              escalations = `${escalations}\n- ${candidate} (${verdict.score})`;

              await tools.memory.createEntities({
                entities: [
                  {
                    name: candidate,
                    entityType: "risk",
                    observations: verdict.reasons
                  }
                ]
              });

              await tools.memory.createRelations({
                relations: [
                  {
                    from: input.repository,
                    to: candidate,
                    relationType: "has-high-risk-file"
                  }
                ]
              });
            } else if (verdict.level === "medium") {
              await tools.memory.addObservations({
                observations: [
                  {
                    entityName: input.repository,
                    contents: [`medium risk at ${candidate}: ${verdict.reasons.join("; ")}`]
                  }
                ]
              });
            } else if (verdict.reasons.length > 0) {
              await tools.memory.addObservations({
                observations: [
                  {
                    entityName: input.repository,
                    contents: [`low risk at ${candidate}`]
                  }
                ]
              });
            }

            findings.push({
              path: candidate,
              level: verdict.level,
              score: verdict.score,
              reasons: verdict.reasons
            });
          } catch (readError) {
            // One unreadable file must not lose the whole root: record it and
            // move to the next root rather than to the next file.
            await tools.memory.addObservations({
              observations: [
                {
                  entityName: input.repository,
                  contents: [`could not read ${candidate}: ${readError}`]
                }
              ]
            });

            continue outer;
          }
        }
      }
    }
  } catch (scanError) {
    await tools.memory.addObservations({
      observations: [
        {
          entityName: input.repository,
          contents: [`scan aborted after ${scanned} file(s): ${scanError}`]
        }
      ]
    });

    return {
      repository: input.repository,
      status: "scan-failed",
      findings
    };
  } finally {
    await tools.memory.addObservations({
      observations: [
        {
          entityName: input.repository,
          contents: [`scan finished: ${scanned} scanned, ${skipped} skipped`]
        }
      ]
    });
  }

  if (findings.length === 0) {
    return { repository: input.repository, status: "clean", findings };
  }

  /* ---------------------------------------------------------------- */
  /* 2 — context, gathered four ways at once                           */
  /* ---------------------------------------------------------------- */

  const primaryRoot = input.roots[0];

  const [readme, owners, docs, related] = await Promise.all([
    tools.fs.readTextFile({ path: `${primaryRoot}/README.md`, head: 60 }),
    tools.fs.readTextFile({ path: `${primaryRoot}/CODEOWNERS` }),
    tools.fs.searchFiles({
      path: primaryRoot,
      pattern: "*.md",
      excludePatterns: ["node_modules", "dist"]
    }),
    tools.memory.searchNodes({ query: `${input.repository} risk` })
  ]);

  // Nested destructuring with a rename: `content` is read out of the search
  // result and bound under a name the rest of the flow uses.
  const { content: docIndex } = docs;

  const context = [
    `readme: ${readme.content.length} chars`,
    `owners: ${owners.content.split("\n").length} lines`,
    `docs: ${docIndex.split("\n").length} files`,
    `related memories: ${related.entities.length}`
  ].join(" · ");

  /* ---------------------------------------------------------------- */
  /* 3 — the report, written with a bounded retry                      */
  /* ---------------------------------------------------------------- */

  const report = renderTriageReport(input.repository, findings);

  const body = `${report}\n\n_context: ${context}_\n${escalations}`;

  let attempt = 0;
  let written = false;
  let lastFailure = "";

  while (attempt < 3 && !written) {
    attempt = attempt + 1;

    try {
      await tools.fs.writeFile({ path: input.reportPath, content: body });
      written = true;
    } catch (writeError) {
      lastFailure = `${writeError}`;

      if (attempt === 3) {
        await tools.memory.addObservations({
          observations: [
            {
              entityName: input.repository,
              contents: [`report write gave up after ${attempt} attempts: ${lastFailure}`]
            }
          ]
        });
      } else {
        await tools.fs.createDirectory({ path: input.reportPath.replace(/\/[^/]+$/, "") });
      }
    }
  }

  if (!written) {
    return {
      repository: input.repository,
      status: "report-failed",
      findings
    };
  }

  /* ---------------------------------------------------------------- */
  /* 4 — escalate, and record what the run concluded                   */
  /* ---------------------------------------------------------------- */

  const high = findings.filter((finding) => finding.level === "high");

  if (high.length > 0) {
    const { results: [{ entityName: escalated }] } = await tools.memory.addObservations({
      observations: [
        {
          entityName: input.repository,
          contents: [`escalated ${high.length} file(s) to ${input.escalateChannel}`]
        }
      ]
    });

    await tools.memory.createRelations({
      relations: [
        {
          from: escalated,
          to: input.escalateChannel,
          relationType: "escalated-to"
        }
      ]
    });
  }

  await tools.fs.writeFile({
    path: `${input.reportPath}.json`,
    content: JSON.stringify({ repository: input.repository, scanned, skipped, findings })
  });

  return {
    repository: input.repository,
    status: "reported",
    findings
  };
}
