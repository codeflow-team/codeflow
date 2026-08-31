/**
 * Four defects a user found by driving the real UI, each of them the same
 * shape: the UI not using what core already knew.
 *
 * - a `number` field was written as `"50"`, and the app then flagged the type
 *   mismatch it could have refused before writing (06 §3);
 * - blanking an optional field wrote `""` instead of removing the property, so
 *   a `number` field could be put into a state the UI could not get it out of;
 * - a positional library-function call showed no editable fields at all, though
 *   `positionalEdits` patches them exactly as it patches object properties;
 * - hovering a row changed its height, so the pane stepped under the pointer.
 *
 * Everything here is the pure layer: what is encoded, what is refused, and what
 * the model says a field is. The components are wiring over these answers, and
 * this package's tests run in node.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRegistry } from "@codeflow-team/core";
import { resolveInspectorFields, type InspectorField } from "../src/inspector/fields.js";
import {
  declaredTypeOf,
  emptyFieldOutcome,
  encodeFieldValue,
  offersUnset,
} from "../src/inspector/edit.js";
import { dropInto } from "../src/editor/drop.js";
import { layoutShiftingStateClasses, REVEAL_ON_HOVER } from "../src/ui/steady.js";
import { field, node } from "./fixtures.js";

/* -------------------------------------------------------------------------- */
/* 4 — a number field commits a number (06 §3)                                 */
/* -------------------------------------------------------------------------- */

describe("encoding follows the field's declared type", () => {
  it("writes 50 into a `number` field as a number, not as \"50\"", () => {
    const maxTickets = field({ name: "maxTickets", label: "Max tickets", schema: { type: "number" } });
    expect(encodeFieldValue("text", "50", false, { field: maxTickets })).toEqual({ ok: true, value: 50 });
  });

  it("reads the type from a TypeScript ref as well as from JSON Schema", () => {
    expect(declaredTypeOf("number")).toBe("number");
    expect(declaredTypeOf({ type: "integer" })).toBe("number");
    expect(declaredTypeOf({ type: "boolean" })).toBe("boolean");
    expect(declaredTypeOf({ type: "array", items: { type: "string" } })).toBeNull();
    expect(declaredTypeOf(undefined)).toBeNull();
  });

  it("writes true into a `boolean` field as a boolean", () => {
    const draft = field({ name: "draft", schema: "boolean" });
    expect(encodeFieldValue("text", "true", false, { field: draft })).toEqual({ ok: true, value: true });
    expect(encodeFieldValue("text", "False", false, { field: draft })).toEqual({ ok: true, value: false });
  });

  it("refuses what does not parse, before it is written, naming the type", () => {
    const amount = field({ name: "amount", label: "Amount", schema: "number" });
    const result = encodeFieldValue("text", "abc", false, { field: amount });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain("number");
    expect(result.message).toContain("Amount");
    expect(result.message).toContain("abc");
  });

  it("refuses a fraction where the schema says `integer`, and says which word it means", () => {
    const count = field({ name: "count", label: "Count", schema: { type: "integer" } });
    const result = encodeFieldValue("text", "2.5", false, { field: count });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain("whole number");
  });

  it("refuses a `boolean` field anything but a boolean, and says what to type", () => {
    const urgent = field({ name: "urgent", schema: "boolean" });
    const result = encodeFieldValue("text", "maybe", false, { field: urgent });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain("`true`");
  });

  it("leaves a field with no declared schema exactly as it was", () => {
    const untyped = field({ name: "note" });
    expect(encodeFieldValue("text", "50", false, { field: untyped })).toEqual({ ok: true, value: "50" });
    expect(encodeFieldValue("text", "50")).toEqual({ ok: true, value: "50" });
    // A `string` schema is a declared type too, and it changes nothing.
    const text = field({ name: "channel", schema: "string" });
    expect(encodeFieldValue("text", "50", false, { field: text })).toEqual({ ok: true, value: "50" });
  });
});

/* -------------------------------------------------------------------------- */
/* 3 — clearing removes the property; empty text is a different gesture        */
/* -------------------------------------------------------------------------- */

describe("clearing a field", () => {
  const optional = field({ name: "head", label: "Head", raw: "10", schema: "number", required: false });
  const requiredField = field({ name: "path", label: "Path", raw: '"a.json"', schema: "string", required: true });

  it("removes the property rather than writing an empty string", () => {
    expect(encodeFieldValue("text", "", false, { field: optional })).toEqual({
      ok: true,
      value: { kind: "remove" },
    });
    expect(emptyFieldOutcome(optional).kind).toBe("remove");
  });

  it("offers the unset on an optional field and not on a required one", () => {
    expect(offersUnset(optional)).toBe(true);
    expect(offersUnset(requiredField)).toBe(false);
  });

  it("still removes a required field that is emptied by hand, and says the step will need a value", () => {
    // 06 §3: clearing a required field removes the property and puts the node
    // into needs-configuration. What is withheld is the *button*, not the edit.
    const outcome = emptyFieldOutcome(requiredField);
    expect(outcome.kind).toBe("remove");
    expect(outcome.message).toContain("required");
  });

  it("keeps empty text reachable for a string field — a different gesture, a different result", () => {
    const channel = field({ name: "channel", label: "Channel", raw: '"#security"', schema: "string" });
    expect(encodeFieldValue("text", "", false, { field: channel, keepEmpty: true })).toEqual({ ok: true, value: "" });
    expect(encodeFieldValue("text", "", false, { field: channel })).toEqual({
      ok: true,
      value: { kind: "remove" },
    });
    expect(emptyFieldOutcome(channel, true).kind).toBe("blank");
    expect(emptyFieldOutcome(channel, false).kind).toBe("remove");
  });

  it("refuses empty text for a field that cannot hold it", () => {
    const outcome = emptyFieldOutcome(optional, true);
    expect(outcome.kind).toBe("refused");
    expect(encodeFieldValue("text", "", false, { field: optional, keepEmpty: true }).ok).toBe(false);
  });

  it("never offers an unset for a construct's own expression", () => {
    const loop = node({ id: "n_loop", type: "loop", label: "For each", path: "flow/for#0", data: { kind: "for", variable: "pr", iterable: "prs" } });
    for (const each of resolveInspectorFields(loop).fields) expect(offersUnset(each)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 2 — positional arguments are fields (06 §2, `positionalEdits`)              */
/* -------------------------------------------------------------------------- */

const LIBRARY = () =>
  createRegistry({
    functions: [
      {
        name: "limitRecords",
        label: "Limit",
        modulePath: "@flows/lib",
        inputSchema: { records: "Record[]", count: "number", from: "string" },
        outputSchema: "Record[]",
        code: "export function limitRecords() {}",
      },
    ],
  });

function limitNode(data: Record<string, unknown>) {
  return node({
    id: "n_limit",
    type: "function",
    label: "Limit",
    path: "flow/call:limitRecords[0]",
    data: {
      functionName: "limitRecords",
      functionSource: "library",
      modulePath: "@flows/lib",
      ...data,
    },
  });
}

const POSITIONAL = () =>
  limitNode({
    argumentStyle: "positional",
    argumentsEditable: true,
    argumentsHaveSpread: false,
    arguments: { records: "oldestFirst", count: "input.maxTickets", from: '"first"' },
    argumentPositions: { records: 0, count: 1, from: 2 },
  });

describe("positional library-function calls", () => {
  it("renders one named field per argument instead of refusing them all", () => {
    const model = resolveInspectorFields(POSITIONAL(), LIBRARY());
    expect(model.fields.map((each) => each.name)).toEqual(["records", "count", "from"]);
    for (const each of model.fields) {
      expect(each.blockedReason).toBeNull();
      expect(each.patch).toBe("field");
    }
    expect(model.fields[1].raw).toBe("input.maxTickets");
    expect(model.fields[1].schema).toBe("number");
  });

  it("takes the slot from the analyzer's table, not from the order of the keys", () => {
    const shuffled = limitNode({
      argumentStyle: "positional",
      argumentsEditable: true,
      argumentsHaveSpread: false,
      arguments: { from: '"first"', records: "rows", count: "3" },
      argumentPositions: { records: 0, count: 1, from: 2 },
    });
    const model = resolveInspectorFields(shuffled, LIBRARY());
    expect(model.fields.map((each) => each.name)).toEqual(["records", "count", "from"]);
    expect(model.fields.map((each) => each.position)).toEqual([0, 1, 2]);
  });

  it("does not offer to unset one — core refuses it, so the UI never asks", () => {
    const model = resolveInspectorFields(POSITIONAL(), LIBRARY());
    for (const each of model.fields) {
      expect(each.removable).toBe(false);
      expect(offersUnset(each)).toBe(false);
    }
  });

  it("says why, rather than writing something, when a positional field is emptied", () => {
    const count = resolveInspectorFields(POSITIONAL(), LIBRARY()).fields[1];
    const result = encodeFieldValue("text", "", false, { field: count });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain("shift every argument after it");
    expect(emptyFieldOutcome(count).kind).toBe("refused");
  });

  it("takes a dropped value exactly as an object-literal field does", () => {
    const count = resolveInspectorFields(POSITIONAL(), LIBRARY()).fields[1];
    const dropped = dropInto(count, { path: "queue.length" }, { text: "" });
    expect(dropped.ok).toBe(true);
    if (!dropped.ok) throw new Error(dropped.message);
    expect(dropped.changes).toEqual({ count: { kind: "expression", text: "queue.length" } });
  });

  it("keeps the refusal, in its existing wording, for an opaque argument", () => {
    const opaque = limitNode({
      argumentStyle: "opaque",
      argumentsEditable: false,
      argumentsHaveSpread: false,
      arguments: {},
      argumentText: "...args",
    });
    const model = resolveInspectorFields(opaque, LIBRARY());
    expect(model.notice).toContain("not a visible object literal");
    for (const each of model.fields) {
      expect(each.blockedReason).toContain("not a visible object literal");
      expect(each.patch).toBeNull();
    }
  });

  it("still refuses a positional call whose arguments the analyzer could not line up", () => {
    // Arity mismatch or a spread: core reports `opaque`/`editable: false`, and
    // the UI does not second-guess it.
    const mismatched = limitNode({
      argumentStyle: "positional",
      argumentsEditable: false,
      argumentsHaveSpread: false,
      arguments: {},
    });
    const model = resolveInspectorFields(mismatched, LIBRARY());
    expect(model.notice).toContain("not a visible object literal");
  });
});

/* -------------------------------------------------------------------------- */
/* 1 — no pointer state changes a box                                          */
/* -------------------------------------------------------------------------- */

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

describe("hover, focus and drag-over never change a box", () => {
  it("catches the class of bug it was written for", () => {
    // The actual offender: `hidden` until hover, then a flex item in a
    // baseline-aligned row — the row grew a pixel and the pane stepped.
    expect(layoutShiftingStateClasses("ml-auto hidden shrink-0 px-1 group-hover:inline-flex")).toEqual([
      "group-hover:inline-flex",
    ]);
    expect(layoutShiftingStateClasses("hover:p-2 focus:border-2 group-hover:font-bold peer-focus:h-10")).toEqual([
      "hover:p-2",
      "focus:border-2",
      "group-hover:font-bold",
      "peer-focus:h-10",
    ]);
  });

  it("leaves paint-only state classes alone", () => {
    expect(
      layoutShiftingStateClasses(
        "hover:bg-surface-2 hover:text-ink hover:border-line-strong focus:ring-2 focus-visible:ring-ring/70 hover:shadow-md hover:opacity-100 hover:underline",
      ),
    ).toEqual([]);
    expect(layoutShiftingStateClasses(REVEAL_ON_HOVER)).toEqual([]);
  });

  it("does not confuse a data/state variant that is not a pointer state", () => {
    expect(layoutShiftingStateClasses("md:flex dark:hidden disabled:opacity-60")).toEqual([]);
  });

  it("holds over every component in the package", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const source = readFileSync(path, "utf8");
      // Comments are prose *about* the bug — the fix's own explanation names
      // the class it removed, and a scanner that read comments would fail on it.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      for (const match of code.matchAll(/["'`]([^"'`\n]*(?:hover|focus|active):[^"'`\n]*)["'`]/g)) {
        for (const bad of layoutShiftingStateClasses(match[1])) {
          offenders.push(`${path.slice(SRC.length + 1)}: ${bad}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe("the model still answers for an ordinary object-literal call", () => {
  it("keeps object properties removable and marks nothing positional", () => {
    const slack = node({
      id: "n_slack",
      type: "tool",
      label: "Slack Send",
      path: "flow/call:slack.send[0]",
      data: {
        toolName: "slack.send",
        resolved: true,
        argumentStyle: "object",
        argumentsEditable: true,
        argumentsHaveSpread: false,
        arguments: { channel: '"#security"' },
      },
    });
    // A JSON Schema is the shape a real MCP tool arrives in: the field's own
    // schema lives under `properties`, and `required` says which are optional.
    const registry = createRegistry({
      tools: [
        {
          name: "slack.send",
          label: "Slack Send",
          inputSchema: {
            type: "object",
            properties: { channel: { type: "string" }, threadTs: { type: "string" } },
            required: ["channel"],
          },
          editableFields: ["channel", "threadTs"],
        },
      ],
    });
    const model = resolveInspectorFields(slack, registry);
    const channel = model.fields.find((each) => each.name === "channel") as InspectorField;
    const thread = model.fields.find((each) => each.name === "threadTs") as InspectorField;
    expect(channel.position).toBeNull();
    expect(channel.removable).toBe(true);
    // Required by the schema: removable, but never offered as a button (06 §3).
    expect(channel.required).toBe(true);
    expect(offersUnset(channel)).toBe(false);
    expect(thread.required).toBe(false);
    expect(offersUnset(thread)).toBe(true);
  });
});
