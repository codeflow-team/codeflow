/**
 * A malformed field value must be refused, not written into the source.
 *
 * ## The bug this suite was written for
 *
 * `06 §3` defines the encoding of a `changes` value: `{ kind: "expression",
 * text }`, `{ kind: "template", text }`, `{ kind: "literal", value }`,
 * `{ kind: "remove" }`. `isFieldValue` checked the `kind` and **nothing else**,
 * so a value with the right kind and the wrong payload key — the single most
 * likely mistake a UI or an AI makes here, `{ kind: "expression", value: … }`
 * instead of `text` — sailed through validation. `renderValue` then returned
 * `undefined`, and:
 *
 *  - **a field edit committed `undefined` into the user's source.**
 *    `browser.resize({ width: input.viewportWidth })` patched with
 *    `{ width: { kind: "literal" } }` became `{ width: undefined }`, reported
 *    success, and raised no diagnostic. The value on screen was replaced by
 *    nothing, which is the exact failure O2 and I6 exist to prevent — the patch
 *    did something other than what the caller asked, quietly.
 *  - **`$insert` committed `undefined` as an argument**, so a node was written
 *    into the flow with its input silently thrown away.
 *  - **a third path crashed with a raw `TypeError`** (`Cannot read properties
 *    of undefined (reading 'length')`, in `mapOffset` via `buildProvenance`)
 *    rather than a `CodeFlowError` with a `patch-*` code — so a host following
 *    `session.patchNode`'s contract ("refusals are thrown as `CodeFlowError`s
 *    … the caller always learns *why*") learned nothing.
 *
 * Found by writing a patch against `browser-qa-runner` with `value:` where the
 * encoding wanted `text:`. Fixed by validating the payload in `isFieldValue`,
 * so every one of these is a `patch-unsupported` refusal that names the key it
 * wanted — and not one byte of the source moves.
 */

import { describe, expect, it } from "vitest";

import { exampleById, open } from "./helpers.js";
import { CodeFlowError } from "../../src/errors.js";
import { isFieldValue } from "../../src/patcher/values.js";

async function refusal(promise: Promise<unknown>): Promise<CodeFlowError> {
  const caught = await promise.catch((error: unknown) => error);
  expect(caught, "expected a refusal, got a result").toBeInstanceOf(CodeFlowError);
  return caught as CodeFlowError;
}

describe("isFieldValue validates the payload, not only the kind (06 §3)", () => {
  it("accepts every well-formed value", () => {
    expect(isFieldValue("text")).toBe(true);
    expect(isFieldValue(42)).toBe(true);
    expect(isFieldValue(true)).toBe(true);
    expect(isFieldValue(null)).toBe(true);
    expect(isFieldValue({ kind: "literal", value: "#a" })).toBe(true);
    expect(isFieldValue({ kind: "literal", value: 1 })).toBe(true);
    expect(isFieldValue({ kind: "literal", value: null })).toBe(true);
    expect(isFieldValue({ kind: "expression", text: "input.x" })).toBe(true);
    expect(isFieldValue({ kind: "template", text: "a ${b}" })).toBe(true);
    expect(isFieldValue({ kind: "remove" })).toBe(true);
  });

  it("rejects the right kind with the wrong payload", () => {
    // `value` where the encoding wants `text` — the mistake that started this.
    expect(isFieldValue({ kind: "expression", value: "input.x" })).toBe(false);
    expect(isFieldValue({ kind: "template", value: "a" })).toBe(false);
    // `text` where the encoding wants `value`.
    expect(isFieldValue({ kind: "literal", text: "#a" })).toBe(false);
    // Payload missing entirely.
    expect(isFieldValue({ kind: "expression" })).toBe(false);
    expect(isFieldValue({ kind: "template" })).toBe(false);
    expect(isFieldValue({ kind: "literal" })).toBe(false);
    // Payload of the wrong type.
    expect(isFieldValue({ kind: "expression", text: 5 })).toBe(false);
    expect(isFieldValue({ kind: "literal", value: { nested: true } })).toBe(false);
    expect(isFieldValue({ kind: "literal", value: [1, 2] })).toBe(false);
  });
});

describe("a field edit with a malformed value", () => {
  it("is refused instead of writing `undefined` over the value on screen", async () => {
    const example = exampleById("browser-qa-runner");
    const { session, graph } = await open(example);
    const resize = graph.nodes.find((node) => node.data["toolName"] === "browser.resize")!;

    const error = await refusal(session.patchNode(resize.id, { width: { kind: "literal" } }));
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toMatch(/value/);

    // The source is untouched, and the graph the session holds is the one it had.
    expect(session.getGraph()?.source.content).toBe(example.source);
    expect(example.source).toContain("width: input.viewportWidth");
  });

  it("is refused rather than crashing with a TypeError", async () => {
    const example = exampleById("browser-qa-runner");
    const { session, graph } = await open(example);
    const create = graph.nodes.find((node) => node.data["toolName"] === "fs.createDirectory")!;

    const error = await refusal(
      // `value:` instead of `text:` — right kind, wrong key.
      session.patchNode(create.id, { path: { kind: "expression", value: "input.artifactDir" } }),
    );
    expect(error.code).toBe("patch-unsupported");
    expect(error).toBeInstanceOf(CodeFlowError);
    expect(session.getGraph()?.source.content).toBe(example.source);
  });

  it("is refused for a template too", async () => {
    const example = exampleById("browser-qa-runner");
    const { session, graph } = await open(example);
    const wait = graph.nodes.find((node) => node.data["toolName"] === "browser.waitFor")!;

    const error = await refusal(session.patchNode(wait.id, { text: { kind: "template" } }));
    expect(error.code).toBe("patch-unsupported");
    expect(session.getGraph()?.source.content).toBe(example.source);
  });

  it("still accepts the well-formed forms of the same edits", async () => {
    const example = exampleById("browser-qa-runner");
    const { session, graph } = await open(example);
    const create = graph.nodes.find((node) => node.data["toolName"] === "fs.createDirectory")!;

    const result = await session.patchNode(create.id, {
      path: { kind: "expression", text: "`${input.artifactDir}/run`" },
    });
    expect(result.patches).toHaveLength(1);
    expect(result.source).toContain("path: `${input.artifactDir}/run`");
  });
});

describe("$insert with a malformed argument", () => {
  it("is refused instead of writing a node whose input is `undefined`", async () => {
    const example = exampleById("research-agent");
    const { session, graph } = await open(example);
    const anchor = graph.nodes.find((node) => node.data["toolName"] === "memory.createRelations")!;

    const error = await refusal(
      session.patchNode(anchor.id, {
        $insert: {
          tool: "memory.addObservations",
          where: "after",
          variable: "audit",
          arguments: {
            observations: {
              kind: "expression",
              value: '[{ entityName: input.topic, contents: ["linked"] }]',
            },
          },
        },
      }),
    );

    expect(error.code).toBe("patch-unsupported");
    expect(session.getGraph()?.source.content).toBe(example.source);
    expect(session.getGraph()?.source.content).not.toContain("observations: undefined");
  });
});
