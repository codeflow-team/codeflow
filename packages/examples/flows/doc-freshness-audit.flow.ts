import type { Tools } from "../generated/tools";
import { renderBrief } from "@flows/lib";

/**
 * Documentation freshness audit — Context7 and DeepWiki against the docs
 * actually checked into the repository.
 *
 * For every dependency the project pins, it pulls the upstream documentation,
 * compares it with the local guide, and files what drifted. Only the local
 * side has a typed result — the doc servers answer by writing their harvest to
 * the workspace — so the comparison happens on files the filesystem server can
 * hand back.
 */

export default async function flow(
  input: {
    docsDir: string;
    manifestPath: string;
    harvestDir: string;
    reportPath: string;
    staleAfterDays: number;
  },
  tools: Tools
) {
  const manifest = await tools.fs.readTextFile({ path: input.manifestPath });

  const dependencies = manifest.content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("@") && !line.startsWith("#"))
    .map((line) => line.split("@")[0]);

  if (dependencies.length === 0) {
    return { status: "no-dependencies", drifted: [] as string[] };
  }

  const localDocs = await tools.fs.listDirectory({ path: input.docsDir });

  const drifted: string[] = [];
  const missing: string[] = [];

  let checked = 0;
  let skipped = 0;

  for (const dependency of dependencies) {
    const localPath = `${input.docsDir}/${dependency}.md`;

    if (!localDocs.content.includes(`${dependency}.md`)) {
      missing.push(dependency);
      skipped = skipped + 1;
      continue;
    }

    try {
      await tools.context7.resolveLibraryId({
        query: `${dependency} documentation`,
        libraryName: dependency
      });

      await tools.context7.queryDocs({
        libraryId: `/${dependency}`,
        query: "getting started"
      });

      const [local, upstream, stat] = await Promise.all([
        tools.fs.readTextFile({ path: localPath }),
        tools.fs.readTextFile({ path: `${input.harvestDir}/${dependency}.md` }),
        tools.fs.getFileInfo({ path: localPath })
      ]);

      checked = checked + 1;

      const localHeadings = local.content
        .split("\n")
        .filter((line) => line.startsWith("#"));

      const upstreamHeadings = upstream.content
        .split("\n")
        .filter((line) => line.startsWith("#"));

      const lost = localHeadings.filter((heading) => !upstreamHeadings.includes(heading));

      const ageLine = stat.content
        .split("\n")
        .find((line) => line.startsWith("modified:"));

      if (lost.length > 3) {
        drifted.push(`${dependency}: ${lost.length} heading(s) no longer upstream`);

        await tools.deepwiki.fetch({
          url: `https://deepwiki.com/${dependency}`,
          maxDepth: 1,
          mode: "aggregate",
          verbose: false
        });
      } else if (upstreamHeadings.length > localHeadings.length * 2) {
        drifted.push(`${dependency}: upstream grew to ${upstreamHeadings.length} sections`);
      } else if (ageLine !== undefined && ageLine.includes("20")) {
        await tools.memory.addObservations({
          observations: [
            {
              entityName: dependency,
              contents: [`checked, ${ageLine}, threshold ${input.staleAfterDays}d`]
            }
          ]
        });
      }
    } catch (auditError) {
      drifted.push(`${dependency}: audit failed — ${auditError}`);
    }
  }

  if (drifted.length === 0 && missing.length === 0) {
    return { status: "fresh", drifted };
  }

  const sections = [
    `checked ${checked} of ${dependencies.length} dependency doc(s)`,
    `missing locally: ${missing.join(", ") || "none"}`,
    ...drifted
  ];

  const report = renderBrief("Documentation freshness", sections);

  await tools.fs.writeFile({ path: input.reportPath, content: report });

  await tools.memory.createEntities({
    entities: [
      {
        name: "documentation-audit",
        entityType: "audit",
        observations: [`${drifted.length} drifted`, `${skipped} skipped`, `report at ${input.reportPath}`]
      }
    ]
  });

  return { status: "drift-found", drifted };
}
