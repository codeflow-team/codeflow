import type { Tools } from "../generated/tools";
import {
  aggregateRecords,
  dateTimeStep,
  dedupeRecords,
  extractJson,
  filterRecords,
  formatText,
  limitRecords,
  runAgentStep,
  setFields,
  sortRecords,
  splitOutField,
  waitMs
} from "@flows/lib";

/**
 * Support triage — one agent step per ticket.
 *
 * The queue is prepared once (parse, split out, de-duplicate, sort, cap), and
 * then every ticket goes through the same four steps of its own: work out when
 * it is due, build a prompt out of its fields, ask the agent, and fold the
 * answer back onto the ticket. That per-iteration shape is the reason this flow
 * exists — it is what the canvas has to show once per pass rather than once.
 *
 * The agent step calls no model. `runAgentStep` is CodeFlow's offline stand-in
 * (the demo runner is given no network of its own), and every answer it returns
 * says so in its own first line. The record it produces carries `simulated:
 * true` for the same reason, so a report built from this flow cannot be mistaken
 * for one a model wrote.
 */

/**
 * Collecting a result is a step too (01 §3), so it gets a name and a statement
 * of its own instead of disappearing into `triaged.push(...)` inside a code node.
 */
function collectTriaged(
  into: Record<string, unknown>[],
  record: Record<string, unknown>
) {
  into.push(record);
}

export default async function flow(
  input: { ticketsPath: string; summaryPath: string; maxTickets: number; pauseMs: number },
  tools: Tools
) {
  const file = await tools.fs.readTextFile({ path: input.ticketsPath });

  const parsed = extractJson(file.content);

  if (!parsed.ok) {
    return { status: "unreadable", reason: parsed.reason, triaged: 0 };
  }

  const raw = splitOutField([parsed.data], "tickets");

  const unique = dedupeRecords(raw, "id");

  const oldestFirst = sortRecords(unique, "openedAt", "ascending");

  const queue = limitRecords(oldestFirst, input.maxTickets, "first");

  if (queue.length === 0) {
    return { status: "empty", reason: "nothing left in the queue after de-duplication", triaged: 0 };
  }

  const triaged: Record<string, unknown>[] = [];
  let skipped = 0;

  for (const ticket of queue) {
    const due = dateTimeStep(String(ticket.openedAt), "add", 2, "days");

    if (!due.ok) {
      skipped = skipped + 1;
      continue;
    }

    const prompt = formatText(
      "Ticket {{ id }} from {{ customer }}, on the {{ plan }} plan.\n\n{{ body }}\n\nAnswer with one sentence of triage, then a priority of P1, P2 or P3.",
      {
        id: ticket.id,
        customer: ticket.customer,
        plan: ticket.plan,
        body: ticket.body
      }
    );

    const verdict = runAgentStep(
      "anthropic/claude-3.5-sonnet",
      "You are a support triage assistant. Be terse. Never invent an SLA.",
      prompt,
      0.2,
      400
    );

    const record = setFields(
      ticket,
      {
        triage: verdict.text,
        simulated: verdict.simulated,
        model: verdict.model,
        dueAt: due.iso,
        dueLabel: due.formatted
      },
      "merge"
    );

    collectTriaged(triaged, record);

    await waitMs(input.pauseMs);
  }

  const enterprise = filterRecords(triaged, (ticket) => ticket.plan === "enterprise");

  const withDueDate = aggregateRecords(triaged, "dueAt", "count");

  try {
    await tools.fs.writeFile({
      path: input.summaryPath,
      content: `Triaged ${triaged.length} ticket(s); ${skipped} skipped, ${enterprise.length} on the enterprise plan. No model was called — every verdict is CodeFlow's offline stand-in.`
    });
  } catch (error) {
    return {
      status: "unwritten",
      reason: `could not write ${input.summaryPath}: ${error}`,
      triaged: triaged.length
    };
  }

  return {
    status: "ok",
    triaged: triaged.length,
    skipped,
    enterprise: enterprise.length,
    withDueDate: withDueDate.value
  };
}
