/**
 * The trigger's input, both halves.
 *
 * The server half reads the flow's first-parameter type and says what shape it
 * is; the browser half validates a value against that answer, remembers it, and
 * hands it to the runner. The two are tested together because the contract
 * between them is the whole feature — a form built from a shape the runner would
 * not accept is worse than no form.
 */

import { describe, expect, it } from "vitest";

import { describeTriggerInput } from "../server/input-shape.ts";
import { resolveWorkspaceToken, synthesizeInput, WORKSPACE_TOKEN } from "../server/input.ts";
import { seedDrafts, seedValue, validateInput, type TriggerInputSpec } from "../src/trigger-input.js";

function flow(parameter: string, body = "return input;"): string {
  return `export default async function flow(${parameter}, tools: Tools) {\n  ${body}\n}\n`;
}

describe("describeTriggerInput", () => {
  it("gives every primitive its own control", () => {
    const spec = describeTriggerInput(flow("input: { name: string; count: number; dry: boolean }"));
    expect(spec.kind).toBe("object");
    expect(spec.fields.map((field) => [field.name, field.kind])).toEqual([
      ["name", "string"],
      ["count", "number"],
      ["dry", "boolean"],
    ]);
  });

  it("turns a union of literals into a select and keeps source order", () => {
    const spec = describeTriggerInput(flow(`input: { suite: "smoke" | "full" | "nightly" }`));
    const field = spec.fields[0];
    expect(field?.kind).toBe("enum");
    expect(field?.options?.map((option) => option.value)).toEqual(["smoke", "full", "nightly"]);
  });

  it("reads `T | undefined` and `foo?:` as the same optional field", () => {
    const spec = describeTriggerInput(flow("input: { a?: string; b: number | undefined }"));
    expect(spec.fields.map((field) => [field.name, field.kind, field.optional])).toEqual([
      ["a", "string", true],
      ["b", "number", true],
    ]);
  });

  it("gives an array of primitives a row control", () => {
    const spec = describeTriggerInput(flow("input: { roots: string[]; sizes: number[] }"));
    expect(spec.fields[0]?.kind).toBe("array");
    expect(spec.fields[0]?.item?.kind).toBe("string");
    expect(spec.fields[1]?.item?.kind).toBe("number");
  });

  it("descends one level into a nested object and no further", () => {
    const spec = describeTriggerInput(flow("input: { limits: { maxFiles: number; deep: { x: string } } }"));
    const limits = spec.fields[0];
    expect(limits?.kind).toBe("object");
    expect(limits?.fields?.map((field) => [field.name, field.kind, field.path])).toEqual([
      ["maxFiles", "number", "limits.maxFiles"],
      ["deep", "json", "limits.deep"],
    ]);
    // 07 §5: never approximate without saying so — the reason is not optional.
    expect(limits?.fields?.[1]?.reason).toMatch(/nested more than one level deep/);
  });

  it("explains, rather than drops, every shape it cannot express", () => {
    const spec = describeTriggerInput(
      flow("input: { opts: Record<string, number>; who: { a: string } | { b: number }; free: unknown; named: Thing }"),
    );
    const byName = new Map(spec.fields.map((field) => [field.name, field]));
    expect([...byName.keys()]).toEqual(["opts", "who", "free", "named"]);
    for (const field of spec.fields) {
      expect(field.kind).toBe("json");
      expect(field.reason).toBeTruthy();
    }
    expect(byName.get("opts")?.reason).toMatch(/generic type/);
    expect(byName.get("who")?.reason).toMatch(/union/);
    expect(byName.get("free")?.reason).toMatch(/says nothing about what a value would look like/);
    expect(byName.get("named")?.reason).toMatch(/named type/);
  });

  it("falls back to a whole-input JSON editor when the parameter is not an object literal", () => {
    const spec = describeTriggerInput(flow("input: FlowInput"));
    expect(spec.kind).toBe("json");
    if (spec.kind !== "json") throw new Error("unreachable");
    expect(spec.reason).toMatch(/named type/);
  });

  it("says there is nothing to fill in when the flow takes no parameter", () => {
    const spec = describeTriggerInput("export default async function flow() {\n  return 1;\n}\n");
    expect(spec.kind).toBe("none");
    expect(spec.suggested).toEqual({});
  });

  it("never throws on a file that will not parse", () => {
    expect(() => describeTriggerInput("export default async function flow(input: {")).not.toThrow();
  });

  it("synthesizes paths against the token, not a directory that will not exist", () => {
    const spec = describeTriggerInput(flow("input: { sourceRoot: string; reportPath: string }"));
    expect(spec.suggested["sourceRoot"]).toBe(WORKSPACE_TOKEN);
    expect(spec.suggested["reportPath"]).toBe(`${WORKSPACE_TOKEN}/report-path.txt`);
  });

  it("attributes the guess wherever a rule produced it", () => {
    const spec = describeTriggerInput(flow("input: { sourceRoot: string; prune: boolean; maxFiles: number }"));
    const byName = new Map(spec.fields.map((field) => [field.name, field]));
    expect(byName.get("sourceRoot")?.why).toMatch(/filesystem MCP server is rooted there/);
    expect(byName.get("prune")?.why).toMatch(/read-only/);
    expect(byName.get("maxFiles")?.why).toMatch(/small count/);
  });
});

describe("resolveWorkspaceToken", () => {
  it("expands the token everywhere in the payload, at any depth", () => {
    const resolved = resolveWorkspaceToken(
      { a: `${WORKSPACE_TOKEN}/x.md`, b: [`${WORKSPACE_TOKEN}`], c: { d: `${WORKSPACE_TOKEN}/y` }, e: 3 },
      "/tmp/run-1/workspace",
    );
    expect(resolved).toEqual({
      a: "/tmp/run-1/workspace/x.md",
      b: ["/tmp/run-1/workspace"],
      c: { d: "/tmp/run-1/workspace/y" },
      e: 3,
    });
  });

  it("leaves a payload with no token exactly as it was", () => {
    const input = { a: "/somewhere/else", n: 1 };
    expect(resolveWorkspaceToken(input, "/tmp/w")).toEqual(input);
  });

  it("agrees with what the runner would have synthesized on its own", () => {
    const source = flow("input: { docsDir: string; reportPath: string }");
    const direct = synthesizeInput(source, { scratch: "/tmp/w" });
    const viaToken = resolveWorkspaceToken(synthesizeInput(source, { scratch: WORKSPACE_TOKEN }), "/tmp/w");
    expect(viaToken).toEqual(direct);
  });
});

describe("validateInput", () => {
  const spec = describeTriggerInput(
    flow("input: { name: string; count: number; roots: string[]; mode: \"a\" | \"b\"; opts: Record<string, number> }"),
  ) as TriggerInputSpec;

  it("passes the suggestion it was seeded with", () => {
    const value = seedValue(spec, null);
    expect(validateInput(spec, value, seedDrafts(spec, value))).toEqual([]);
  });

  it("blocks text typed into a number, in the inspector's own words", () => {
    const value = seedValue(spec, null);
    const drafts = { ...seedDrafts(spec, value), count: "three" };
    const problems = validateInput(spec, value, drafts);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toBe("count wants a number, but “three” is a piece of text.");
  });

  it("blocks a row of a list that is the wrong kind", () => {
    const value = { ...seedValue(spec, null), roots: [1] };
    const problems = validateInput(spec, value as Record<string, unknown>, seedDrafts(spec, value));
    expect(problems[0]?.path).toBe("roots.0");
    expect(problems[0]?.message).toMatch(/wants a piece of text, but this is a number/);
  });

  it("blocks a value outside a select's options", () => {
    const value = { ...seedValue(spec, null), mode: "c" };
    const problems = validateInput(spec, value, seedDrafts(spec, value));
    expect(problems[0]?.message).toMatch(/must be one of "a", "b"/);
  });

  /*
   * Regression: a JSON field's value only catches up with its text once the
   * text parses, so half-typed JSON leaves the value at the previous one —
   * `null`, here. Checking the value first let invalid JSON through into a run.
   */
  it("blocks half-typed JSON even though the value behind it is still valid", () => {
    const value = seedValue(spec, null);
    const drafts = { ...seedDrafts(spec, value), opts: '{ "a": [1,2' };
    const problems = validateInput(spec, value, drafts);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.path).toBe("opts");
    expect(problems[0]?.message).toMatch(/is not valid JSON/);
  });

  it("refuses a whole-input JSON editor that is not an object", () => {
    const jsonSpec = describeTriggerInput(flow("input: FlowInput"));
    expect(validateInput(jsonSpec, {}, { "": "[1, 2]" })[0]?.message).toMatch(/takes an object, but this is a list/);
    expect(validateInput(jsonSpec, {}, { "": "{oops" })[0]?.message).toMatch(/not valid JSON/);
    expect(validateInput(jsonSpec, {}, { "": '{"a":1}' })).toEqual([]);
  });
});

describe("seedValue", () => {
  const spec = describeTriggerInput(flow("input: { name: string; count: number }"));

  it("lays a remembered input over the suggestion", () => {
    expect(seedValue(spec, { name: "mine" })).toEqual({ name: "mine", count: 3 });
  });

  /*
   * The flow's text is editable, so what was remembered yesterday can be the
   * wrong shape today. Taking it wholesale would hand the run a payload nobody
   * had checked.
   */
  it("drops a remembered value the type has outgrown", () => {
    expect(seedValue(spec, { name: 7, count: 12, gone: "x" })).toEqual({ name: "demo name", count: 12 });
  });
});
