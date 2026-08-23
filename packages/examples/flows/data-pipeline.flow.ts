import type { Tools } from "../generated/tools";
import { normalizeRow, parseDelimited, renderLedger } from "@flows/lib";

/**
 * Regional sales pipeline — filesystem MCP for the data, the "everything"
 * reference server for the enrichment and progress reporting.
 *
 * Reads every drop file in an inbox, normalises the rows it can and quarantines
 * the ones it cannot, folds the survivors into per-region totals, enriches each
 * region with live conditions, and writes a ledger plus a rejects file. The
 * fold itself is plain TypeScript — it stays a code node on the canvas, which
 * is the honest thing for it to be.
 */

interface Total {
  region: string;
  total: number;
  count: number;
}

const CITY_BY_REGION: Record<string, "New York" | "Chicago" | "Los Angeles"> = {
  east: "New York",
  central: "Chicago",
  west: "Los Angeles"
};

export default async function flow(
  input: {
    inboxDir: string;
    ledgerPath: string;
    rejectsPath: string;
    delimiter: string;
    maxRejects: number;
  },
  tools: Tools
) {
  /* ---------------------------------------------------------------- */
  /* 0 — what is in the inbox?                                         */
  /* ---------------------------------------------------------------- */

  const inbox = await tools.fs.listDirectory({ path: input.inboxDir });

  const drops = inbox.content
    .split("\n")
    .filter((line) => line.startsWith("[FILE]"))
    .map((line) => line.replace("[FILE]", "").trim())
    .filter((name) => name.endsWith(".csv") || name.endsWith(".tsv"));

  if (drops.length === 0) {
    return { status: "empty-inbox", totals: [] as Total[], rejected: 0 };
  }

  await tools.everything.toggleSimulatedLogging({});

  await tools.everything.echo({
    message: `pipeline start: ${drops.length} drop file(s) from ${input.inboxDir}`
  });

  /* ---------------------------------------------------------------- */
  /* 1 — read, normalise, fold                                         */
  /* ---------------------------------------------------------------- */

  const totals: Total[] = [];
  const rejects: string[] = [];

  let read = 0;
  let accepted = 0;
  let quarantined = 0;

  dropLoop: for (const drop of drops) {
    const dropPath = `${input.inboxDir}/${drop}`;

    let raw = "";

    try {
      const stat = await tools.fs.getFileInfo({ path: dropPath });

      if (stat.content.includes("size: 0")) {
        quarantined = quarantined + 1;
        continue dropLoop;
      }

      const file = await tools.fs.readTextFile({ path: dropPath });

      raw = file.content;
      read = read + 1;
    } catch (readError) {
      rejects.push(`${dropPath}: ${readError}`);
      quarantined = quarantined + 1;
      continue dropLoop;
    }

    // A `.tsv` drop overrides the configured delimiter — plumbing, not a step.
    const delimiter = drop.endsWith(".tsv") ? "\t" : input.delimiter;

    const { headers, rows } = parseDelimited(raw, delimiter);

    if (headers.length === 0) {
      rejects.push(`${dropPath}: no header row`);
      quarantined = quarantined + 1;
      continue dropLoop;
    }

    for (const row of rows) {
      if (rejects.length > input.maxRejects) {
        break dropLoop;
      }

      const outcome = normalizeRow(headers, row);

      if (!outcome.ok) {
        rejects.push(`${dropPath}: ${outcome.reason}`);
        quarantined = quarantined + 1;
        continue;
      }

      const record = outcome.record;

      if (record === undefined) {
        rejects.push(`${dropPath}: normaliser returned no record`);
        continue;
      }

      // The fold: not one step of it is a flow step, and CodeFlow says so by
      // keeping the whole run verbatim in one code node instead of inventing six.
      const bucket = totals.find((entry) => entry.region === record.region);
      const target = bucket ?? { region: record.region, total: 0, count: 0 };
      const slot = bucket === undefined ? totals.length : totals.indexOf(bucket);
      target.total = target.total + record.amount;
      target.count = target.count + 1;
      totals.splice(slot, bucket === undefined ? 0 : 1, target);
      accepted = accepted + 1;
    }

    await tools.everything.echo({
      message: `${drop}: ${rows.length} row(s), ${accepted} accepted so far`
    });
  }

  if (accepted === 0) {
    await tools.fs.writeFile({
      path: input.rejectsPath,
      content: rejects.join("\n")
    });

    return { status: "all-rejected", totals, rejected: quarantined };
  }

  /* ---------------------------------------------------------------- */
  /* 2 — enrichment: three regions and the previous ledger, at once    */
  /* ---------------------------------------------------------------- */

  const [east, central, west, previous] = await Promise.all([
    tools.everything.getStructuredContent({ location: "New York" }),
    tools.everything.getStructuredContent({ location: "Chicago" }),
    tools.everything.getStructuredContent({ location: "Los Angeles" }),
    tools.fs.readTextFile({ path: input.ledgerPath, tail: 40 })
  ]);

  // Nested destructuring with renames, straight off the parallel merge.
  const { temperature: eastTemp, conditions: eastSky } = east;
  const { temperature: centralTemp } = central;
  const { temperature: westTemp, humidity: westHumidity } = west;

  const weather = new Map<string, number>([
    ["east", eastTemp],
    ["central", centralTemp],
    ["west", westTemp]
  ]);

  let annotated = 0;

  for (const total of totals) {
    const city = CITY_BY_REGION[total.region];

    if (city === undefined) {
      await tools.everything.getAnnotatedMessage({
        messageType: "debug",
        includeImage: false
      });

      continue;
    }

    const degrees = weather.get(total.region);

    if (degrees === undefined) {
      continue;
    } else if (degrees > 25) {
      await tools.everything.echo({
        message: `${total.region} (${city}) is warm at ${degrees}° — ${total.count} order(s)`
      });

      annotated = annotated + 1;
    } else if (degrees < 5) {
      await tools.everything.getAnnotatedMessage({
        messageType: "error",
        includeImage: true
      });

      annotated = annotated + 1;
    } else {
      await tools.everything.echo({
        message: `${total.region} nominal at ${degrees}°`
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* 3 — publish, with a bounded retry and a long-running compaction   */
  /* ---------------------------------------------------------------- */

  const ledger = renderLedger(totals);

  const document = `# Ledger\n\n${ledger}\n\n_east ${eastSky} ${eastTemp}°, west humidity ${westHumidity}%, previous ledger ${previous.content.length} bytes, ${annotated} region(s) annotated_`;

  let attempts = 0;
  let published = false;

  while (attempts < 3 && !published) {
    attempts = attempts + 1;

    try {
      await tools.everything.triggerLongRunningOperation({
        duration: 2,
        steps: totals.length
      });

      await tools.fs.writeFile({ path: input.ledgerPath, content: document });

      published = true;
    } catch (writeError) {
      rejects.push(`ledger attempt ${attempts}: ${writeError}`);

      await tools.fs.createDirectory({
        path: input.ledgerPath.replace(/\/[^/]+$/, "")
      });
    }
  }

  if (!published) {
    return { status: "publish-failed", totals, rejected: quarantined };
  }

  await tools.fs.writeFile({
    path: input.rejectsPath,
    content: rejects.join("\n")
  });

  await tools.everything.gzipFileAsResource({
    name: input.ledgerPath,
    data: document,
    outputType: "resourceLink"
  });

  await tools.everything.echo({
    message: `pipeline done: ${read} file(s), ${accepted} row(s), ${quarantined} quarantined`
  });

  return { status: "published", totals, rejected: quarantined };
}
