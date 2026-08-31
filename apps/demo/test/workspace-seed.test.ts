/**
 * The workspace a run starts from, and the defaults that point into it.
 *
 * Two files have to agree: `runner.ts` writes the seeded documents, and
 * `input.ts` decides that `ticketsPath` means `tickets.json`. Either one alone
 * is a run that stops on its first step — a default naming a file nobody wrote,
 * or a file nobody's default names. So the agreement is checked rather than
 * assumed.
 *
 * The seeded content is checked too, and not for its own sake: `tickets.json`
 * repeats `T-1` so that Remove Duplicates has a duplicate to remove, and gives
 * `T-3` a timestamp that is not a date so the "could not read this one" branch
 * is a branch that runs. Tidy that data up and both steps still pass while
 * demonstrating nothing, which is the failure this file exists to catch.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { seedWorkspace } from "../server/runner.ts";
import { synthesizeInput, WORKSPACE_DOCUMENTS, WORKSPACE_TOKEN } from "../server/input.ts";

let workspace = "";

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "codeflow-seed-test-"));
  seedWorkspace(workspace);
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspace, name), "utf8")) as Record<string, unknown>;
}

describe("the seeded workspace", () => {
  it("creates every document the input defaults are allowed to name", () => {
    for (const document of WORKSPACE_DOCUMENTS) {
      expect(existsSync(join(workspace, document)), `${document} is named by a default but never written`).toBe(true);
    }
  });

  it("gives the order digest orders in more than one status", () => {
    const orders = readJson("orders.json")["orders"] as { status: string; total: number; customer: string }[];
    expect(orders.length).toBeGreaterThan(1);
    const statuses = new Set(orders.map((order) => order.status));
    // More than one, or filtering on status keeps everything and proves nothing.
    expect(statuses.size).toBeGreaterThan(1);
    expect(statuses).toContain("paid");
    // …and more than one customer, so grouping and joining have groups.
    expect(new Set(orders.map((order) => order.customer)).size).toBeGreaterThan(1);
  });

  it("gives the triage queue a duplicate to remove and a date it cannot read", () => {
    const tickets = readJson("tickets.json")["tickets"] as { id: string; openedAt: string }[];
    const ids = tickets.map((ticket) => ticket.id);
    expect(ids.length).toBeGreaterThan(new Set(ids).size);

    const unreadable = tickets.filter((ticket) => Number.isNaN(Date.parse(ticket.openedAt)));
    expect(unreadable.length).toBeGreaterThan(0);
    // …and not *every* date, or the loop skips every pass and the steps after
    // the guard never run.
    expect(unreadable.length).toBeLessThan(tickets.length);
  });
});

describe("the defaults a flow starts from", () => {
  it("points a document-shaped parameter at that document", () => {
    const source = `
export default async function flow(
  input: { ticketsPath: string; ordersPath: string; summaryPath: string; status: string },
  tools: any
) {
  return input;
}
`;
    const input = synthesizeInput(source, { scratch: WORKSPACE_TOKEN });
    expect(input["ticketsPath"]).toBe(`${WORKSPACE_TOKEN}/tickets.json`);
    expect(input["ordersPath"]).toBe(`${WORKSPACE_TOKEN}/orders.json`);
    // A path the flow writes stays a fresh file — naming the document it reads
    // would have a run overwrite its own input.
    expect(input["summaryPath"]).toBe(`${WORKSPACE_TOKEN}/summary-path.txt`);
    // And a status the seeded orders actually carry, so the filter keeps rows.
    const orders = readJson("orders.json")["orders"] as { status: string }[];
    expect(orders.map((order) => order.status)).toContain(input["status"]);
  });
});
