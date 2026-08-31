import type { Tools } from "../generated/tools";
import {
  aggregateRecords,
  extractJson,
  filterRecords,
  formatText,
  limitRecords,
  sortRecords,
  splitOutField
} from "@flows/lib";

/**
 * Order digest — the everyday steps, one per line.
 *
 * Reads a JSON document off disk, pulls the orders out of it, keeps the ones in
 * the status the caller asked about, ranks them, and writes a one-paragraph
 * digest back. Nothing here is clever; that is the point. It is the shortest
 * flow in the gallery that still uses seven different library steps, so it is
 * the one to open first when the question is "what does a node in this editor
 * actually configure?".
 *
 * The two guards at the top are the whole story about honest failure: a file
 * that is not JSON and a document with no orders in it are different problems,
 * and the flow says which one it hit instead of returning zero and letting the
 * reader guess.
 */

export default async function flow(
  input: { ordersPath: string; reportPath: string; status: string },
  tools: Tools
) {
  const file = await tools.fs.readTextFile({ path: input.ordersPath });

  const parsed = extractJson(file.content);

  if (!parsed.ok) {
    return { status: "unreadable", reason: parsed.reason, written: 0 };
  }

  const orders = splitOutField([parsed.data], "orders");

  if (orders.length === 0) {
    return { status: "empty", reason: "the document parsed but carries no orders", written: 0 };
  }

  const matching = filterRecords(orders, (order) => order.status === input.status);

  const ranked = sortRecords(matching, "total", "descending");

  const top = limitRecords(ranked, 5, "first");

  const revenue = aggregateRecords(matching, "total", "sum");

  const names = aggregateRecords(top, "customer", "join");

  const report = formatText(
    "{{ count }} {{ status }} order(s), {{ revenue }} in total.\nBiggest first: {{ names }}.",
    {
      count: matching.length,
      status: input.status,
      revenue: revenue.value,
      names: names.value
    }
  );

  await tools.fs.writeFile({ path: input.reportPath, content: report });

  return {
    status: revenue.ok ? "ok" : "no-totals",
    orders: orders.length,
    matching: matching.length,
    revenue: revenue.value,
    written: report.length
  };
}
