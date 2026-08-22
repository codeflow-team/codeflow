import { describe, expect, it } from "vitest";
import { Node } from "ts-morph";
import { TsMorphParser } from "../src/parser/index.js";
import {
  PathScope,
  callSegment,
  coldNodeId,
  computeEdgeId,
  computeGraphId,
  fingerprintNode,
  fingerprintNodes,
  normalizeAst,
  positionAt,
  withRole,
} from "../src/mapper/index.js";

function firstStatement(source: string): Node {
  const tree = new TsMorphParser().parse(source);
  return tree.sourceFile.getStatements()[0];
}

describe("fingerprint (03 §4)", () => {
  it("ignores whitespace, line breaks and comments", () => {
    const a = firstStatement(`const x = foo({ a: 1, b: "two" });`);
    const b = firstStatement(
      `const x = foo({\n  // a comment\n  a: 1,\n  /* block */ b: "two"\n});`,
    );
    expect(fingerprintNode(a)).toBe(fingerprintNode(b));
  });

  it("changes when a literal changes", () => {
    expect(fingerprintNode(firstStatement(`const x = f("a");`))).not.toBe(
      fingerprintNode(firstStatement(`const x = f("b");`)),
    );
  });

  it("distinguishes const from let (token not visited by forEachChild)", () => {
    expect(fingerprintNode(firstStatement(`const x = 1;`))).not.toBe(
      fingerprintNode(firstStatement(`let x = 1;`)),
    );
  });

  it("distinguishes prefix unary operators", () => {
    expect(fingerprintNode(firstStatement(`const x = !y;`))).not.toBe(
      fingerprintNode(firstStatement(`const x = -y;`)),
    );
  });

  it("distinguishes optional chaining from plain access", () => {
    expect(fingerprintNode(firstStatement(`const x = a.b;`))).not.toBe(
      fingerprintNode(firstStatement(`const x = a?.b;`)),
    );
  });

  it("normalized form carries kinds, not trivia", () => {
    expect(normalizeAst(firstStatement(`const x = 1;`))).toContain("VariableStatement");
    expect(normalizeAst(firstStatement(`const x = 1;`))).not.toContain(" ");
  });

  it("a run of one statement fingerprints identically to that statement", () => {
    const statement = firstStatement(`const x = 1;`);
    expect(fingerprintNodes([statement])).toBe(fingerprintNode(statement));
  });

  it("a run fingerprint depends on order", () => {
    const a = firstStatement(`const x = 1;`);
    const b = firstStatement(`const y = 2;`);
    expect(fingerprintNodes([a, b])).not.toBe(fingerprintNodes([b, a]));
  });
});

describe("semantic path (03 §5.1)", () => {
  it("numbers siblings per prefix inside one scope", () => {
    const scope = new PathScope("flow");
    expect(scope.next(callSegment("slack.send"))).toBe("flow/call:slack.send[0]");
    expect(scope.next(callSegment("slack.send"))).toBe("flow/call:slack.send[1]");
    expect(scope.next("if")).toBe("flow/if[0]");
    expect(scope.next(callSegment("slack.send"))).toBe("flow/call:slack.send[2]");
  });

  it("nested scopes restart their counters", () => {
    const outer = new PathScope("flow");
    const loop = outer.next("for");
    const inner = PathScope.under(loop);
    expect(inner.next("if")).toBe("flow/for[0]/if[0]");
    expect(outer.next("if")).toBe("flow/if[0]");
  });

  it("names merged statement runs by their span", () => {
    const scope = new PathScope("flow");
    expect(scope.statements(1, 3)).toBe("flow/stmt[1..3]");
    expect(scope.statements(2, 2)).toBe("flow/stmt[2]");
  });

  it("adds role qualifiers for synthetic nodes (03 §4)", () => {
    expect(withRole("flow/if[0]", "merge")).toBe("flow/if[0]#merge");
    expect(withRole("flow", "trigger")).toBe("flow#trigger");
  });
});

describe("identity generation (03 §5.0)", () => {
  it("node ids are a deterministic function of the semantic path", () => {
    expect(coldNodeId("flow/if[0]")).toBe(coldNodeId("flow/if[0]"));
    expect(coldNodeId("flow/if[0]")).not.toBe(coldNodeId("flow/if[1]"));
    expect(coldNodeId("flow/if[0]")).toMatch(/^n_[0-9a-f]{12}$/);
  });

  it("node ids do not encode content — only structure", () => {
    // Same path, different tool: the analyzer would produce the same id, which
    // is exactly why changing a node's tool can keep its identity (03 §5.0).
    expect(coldNodeId("flow/call:slack.send[0]")).not.toBe(
      coldNodeId("flow/call:slack.notify[0]"),
    );
  });

  it("edge ids depend on endpoints, kind and ports", () => {
    const base = computeEdgeId("a", "b", "control");
    expect(computeEdgeId("a", "b", "control")).toBe(base);
    expect(computeEdgeId("a", "b", "data")).not.toBe(base);
    expect(computeEdgeId("a", "b", "control", "true")).not.toBe(base);
    expect(computeEdgeId("a", "b", "control", "false")).not.toBe(
      computeEdgeId("a", "b", "control", "true"),
    );
    expect(base).toMatch(/^e_[0-9a-f]{12}$/);
  });

  it("graph ids depend on file, content and registry", () => {
    expect(computeGraphId("a.ts", "c1", "r1")).toBe(computeGraphId("a.ts", "c1", "r1"));
    expect(computeGraphId("a.ts", "c1", "r1")).not.toBe(computeGraphId("a.ts", "c1", "r2"));
    expect(computeGraphId("a.ts", "c1", "r1")).not.toBe(computeGraphId("b.ts", "c1", "r1"));
  });
});

describe("positions", () => {
  it("reports 1-based line/column with the 0-based offset", () => {
    const tree = new TsMorphParser().parse("const a = 1;\nconst b = 2;\n");
    expect(positionAt(tree.sourceFile, 0)).toEqual({ line: 1, column: 1, offset: 0 });
    expect(positionAt(tree.sourceFile, 13)).toEqual({ line: 2, column: 1, offset: 13 });
  });
});
