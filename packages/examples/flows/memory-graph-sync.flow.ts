import type { Tools } from "../generated/tools";
import { isSourcePath } from "@flows/lib";

/**
 * Knowledge-graph sync — filesystem MCP in, memory MCP out.
 *
 * Keeps the memory server's picture of a codebase in step with what is
 * actually on disk: new modules become entities, modules that disappeared are
 * removed, and every module is linked to the package that owns it. Small
 * enough to read in one sitting, and still shows the shape every longer flow
 * here is built from.
 */

export default async function flow(
  input: { packageName: string; sourceRoot: string; prune: boolean },
  tools: Tools
) {
  const existing = await tools.memory.searchNodes({ query: input.packageName });

  const knownPaths = existing.entities
    .filter((entity) => entity.entityType === "module")
    .map((entity) => entity.name);

  const found = await tools.fs.searchFiles({
    path: input.sourceRoot,
    pattern: "*.ts",
    excludePatterns: ["node_modules", "dist", "*.test.ts"]
  });

  const paths = found.content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (paths.length === 0) {
    return { package: input.packageName, added: 0, removed: 0, status: "no-sources" };
  }

  await tools.memory.createEntities({
    entities: [
      {
        name: input.packageName,
        entityType: "package",
        observations: [`${paths.length} source file(s) under ${input.sourceRoot}`]
      }
    ]
  });

  let added = 0;
  let refreshed = 0;

  for (const path of paths) {
    if (!isSourcePath(path)) {
      continue;
    }

    try {
      const file = await tools.fs.readTextFile({ path, head: 40 });

      const exports = file.content
        .split("\n")
        .filter((line) => line.startsWith("export "))
        .map((line) => line.slice(0, 80));

      if (knownPaths.includes(path)) {
        await tools.memory.addObservations({
          observations: [
            {
              entityName: path,
              contents: [`re-scanned: ${exports.length} export(s)`]
            }
          ]
        });

        refreshed = refreshed + 1;
      } else {
        await tools.memory.createEntities({
          entities: [
            {
              name: path,
              entityType: "module",
              observations: exports
            }
          ]
        });

        await tools.memory.createRelations({
          relations: [
            {
              from: input.packageName,
              to: path,
              relationType: "contains"
            }
          ]
        });

        added = added + 1;
      }
    } catch (error) {
      await tools.memory.addObservations({
        observations: [
          {
            entityName: input.packageName,
            contents: [`could not read ${path}: ${error}`]
          }
        ]
      });
    }
  }

  const gone = knownPaths.filter((path) => !paths.includes(path));

  if (gone.length === 0) {
    return { package: input.packageName, added, removed: 0, status: "in-sync" };
  }

  if (!input.prune) {
    await tools.memory.addObservations({
      observations: [
        {
          entityName: input.packageName,
          contents: [`${gone.length} stale module(s) left in place (prune is off)`]
        }
      ]
    });

    return { package: input.packageName, added, removed: 0, status: "stale-kept" };
  }

  const removal = await tools.memory.deleteEntities({ entityNames: gone });

  await tools.memory.addObservations({
    observations: [
      {
        entityName: input.packageName,
        contents: [
          `pruned ${gone.length} module(s): ${removal.message}`,
          `${added} added, ${refreshed} refreshed`
        ]
      }
    ]
  });

  return {
    package: input.packageName,
    added,
    removed: gone.length,
    status: removal.success ? "pruned" : "prune-failed"
  };
}
