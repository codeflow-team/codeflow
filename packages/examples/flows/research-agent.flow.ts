import type { Tools } from "../generated/tools";
import { planQueries, rankSources, renderBrief } from "@flows/lib";

/**
 * Research agent — DuckDuckGo + DeepWiki + Context7 + Sequential Thinking,
 * with the knowledge graph and the workspace as its memory.
 *
 * Plans a set of queries around one topic, harvests and ranks sources, reads
 * the promising ones, reasons over what it found until the reasoning server
 * says it is done, and files a brief. Every retry has a visible bound; every
 * failure is written down rather than swallowed.
 */

interface Section {
  url: string;
  title: string;
  score: number;
  text: string;
}

export default async function flow(
  input: {
    topic: string;
    depth: number;
    minScore: number;
    harvestPath: string;
    briefPath: string;
  },
  tools: Tools
) {
  /* ---------------------------------------------------------------- */
  /* 0 — do we already know this?                                      */
  /* ---------------------------------------------------------------- */

  const known = await tools.memory.searchNodes({ query: input.topic });

  const cached = known.entities.filter((entity) => entity.entityType === "brief");

  if (cached.length > 0 && input.depth <= 1) {
    return {
      topic: input.topic,
      status: "already-known",
      sections: [] as Section[]
    };
  }

  await tools.memory.createEntities({
    entities: [
      {
        name: input.topic,
        entityType: "topic",
        observations: [`research started at depth ${input.depth}`]
      }
    ]
  });

  const queries = planQueries(input.topic, input.depth);

  if (queries.length === 0) {
    return { topic: input.topic, status: "no-plan", sections: [] as Section[] };
  }

  /* ---------------------------------------------------------------- */
  /* 1 — harvest: a bounded retry around each query, then a rank pass  */
  /* ---------------------------------------------------------------- */

  const sections: Section[] = [];

  let harvested = 0;
  let rejected = 0;
  let lastError = "";

  queryLoop: for (const query of queries) {
    let attempt = 0;
    let raw = "";

    // Bounded by `attempt`, which the body updates on every pass.
    while (attempt < 3 && raw.length === 0) {
      attempt = attempt + 1;

      try {
        await tools.search.webSearch({
          query,
          count: 10,
          safeSearch: "moderate"
        });

        const harvest = await tools.fs.readTextFile({ path: input.harvestPath });

        raw = harvest.content;
      } catch (searchError) {
        lastError = `${searchError}`;

        await tools.memory.addObservations({
          observations: [
            {
              entityName: input.topic,
              contents: [`query "${query}" attempt ${attempt} failed: ${lastError}`]
            }
          ]
        });
      }
    }

    if (raw.length === 0) {
      rejected = rejected + 1;
      continue queryLoop;
    }

    const ranked = rankSources(raw, input.minScore);

    for (const source of ranked) {
      if (source.score < input.minScore) {
        rejected = rejected + 1;
        continue;
      }

      // Plumbing between two servers: a GitHub URL is already a Context7 id.
      const libraryId = source.url
        .replace("https://github.com", "")
        .replace(/\/$/, "");

      try {
        if (source.url.includes("github.com")) {
          await tools.deepwiki.fetch({
            url: source.url,
            maxDepth: 2,
            mode: "aggregate"
          });

          await tools.context7.queryDocs({
            libraryId,
            query: `${input.topic} ${query}`
          });
        } else if (source.score >= 8) {
          await tools.deepwiki.fetch({ url: source.url, mode: "pages" });
        } else {
          await tools.search.webSearch({ query: `${source.title} summary`, count: 3 });
        }

        const page = await tools.fs.readTextFile({
          path: `${input.harvestPath}.pages`,
          head: 200
        });

        harvested = harvested + 1;

        sections.push({
          url: source.url,
          title: source.title,
          score: source.score,
          text: page.content
        });

        await tools.memory.createRelations({
          relations: [
            {
              from: input.topic,
              to: source.url,
              relationType: "sourced-from"
            }
          ]
        });
      } catch (fetchError) {
        // A dead source is not a dead query, but it does mean this query's
        // remaining sources are stale — go back to the query loop.
        await tools.memory.addObservations({
          observations: [
            {
              entityName: input.topic,
              contents: [`dropped ${source.url}: ${fetchError}`]
            }
          ]
        });

        continue queryLoop;
      }
    }
  }

  if (sections.length === 0) {
    return {
      topic: input.topic,
      status: "nothing-found",
      sections
    };
  }

  /* ---------------------------------------------------------------- */
  /* 2 — four independent lookups, one wait                            */
  /* ---------------------------------------------------------------- */

  const primary = sections[0];

  const [resolution, notes, neighbours, firstThought] = await Promise.all([
    tools.context7.resolveLibraryId({ query: input.topic, libraryName: primary.title }),
    tools.fs.readTextFile({ path: `${input.harvestPath}.notes`, tail: 80 }),
    tools.memory.searchNodes({ query: `${input.topic} related` }),
    tools.reasoning.sequentialThinking({
      thought: `Frame the brief on ${input.topic} from ${sections.length} sources`,
      thoughtNumber: 1,
      totalThoughts: 5,
      nextThoughtNeeded: true
    })
  ]);

  // `resolution` is `void` — the Context7 server declares no output schema, so
  // the flow reads what it needs off the notes file instead of pretending.
  const { content: noteText } = notes;

  const neighbourNames = neighbours.entities.map((entity) => entity.name).join(", ");

  /* ---------------------------------------------------------------- */
  /* 3 — reason until the server says stop, at most eight steps        */
  /* ---------------------------------------------------------------- */

  const reasoning: string[] = [];

  let thoughtNumber = firstThought.thoughtNumber + 1;
  let totalThoughts = firstThought.totalThoughts;
  let keepThinking = firstThought.nextThoughtNeeded;

  while (keepThinking && thoughtNumber <= 8) {
    const step = await tools.reasoning.sequentialThinking({
      thought: `Step ${thoughtNumber} of ${totalThoughts} over ${sections.length} sources (${neighbourNames})`,
      thoughtNumber,
      totalThoughts,
      nextThoughtNeeded: true,
      branchFromThought: 1,
      branchId: input.topic
    });

    reasoning.push(`thought ${step.thoughtNumber}/${step.totalThoughts}`);

    keepThinking = step.nextThoughtNeeded;
    totalThoughts = step.totalThoughts;
    thoughtNumber = thoughtNumber + 1;

    if (step.branches.length > 2) {
      await tools.memory.addObservations({
        observations: [
          {
            entityName: input.topic,
            contents: [`reasoning branched ${step.branches.length} ways`]
          }
        ]
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* 4 — write the brief                                               */
  /* ---------------------------------------------------------------- */

  const bodies = sections.map(
    (section) => `${section.title} (${section.score}) — ${section.url}\n${section.text.slice(0, 400)}`
  );

  const brief = renderBrief(input.topic, bodies);

  const document = `${brief}\n\n---\nnotes: ${noteText.length} chars · reasoning: ${reasoning.length} steps · harvested ${harvested}, rejected ${rejected}`;

  await tools.fs.writeFile({ path: input.briefPath, content: document });

  await tools.memory.createEntities({
    entities: [
      {
        name: `${input.topic} brief`,
        entityType: "brief",
        observations: [`written to ${input.briefPath}`, `covers ${sections.length} sources`]
      }
    ]
  });

  await tools.memory.createRelations({
    relations: [
      {
        from: input.topic,
        to: `${input.topic} brief`,
        relationType: "produced"
      }
    ]
  });

  return {
    topic: input.topic,
    status: "briefed",
    sections
  };
}
