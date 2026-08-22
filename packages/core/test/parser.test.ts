import { describe, expect, it } from "vitest";
import { Node } from "ts-morph";
import { TsMorphParser, createParser, isTsSyntaxTree } from "../src/parser/index.js";

const SOURCE = `export default async function flow(input: { a: string }, tools: unknown) {
  const x = input.a;
  return x;
}
`;

describe("TsMorphParser (02 §3)", () => {
  it("parses a flow file into a ts-morph source file", () => {
    const tree = createParser().parse(SOURCE);
    expect(isTsSyntaxTree(tree)).toBe(true);
    expect(tree.content).toBe(SOURCE);
    expect(tree.file).toBe("flow.ts");
    expect(tree.sourceFile.getFunctions()).toHaveLength(1);
  });

  it("honours an explicit document path", () => {
    const tree = createParser().parse(SOURCE, "flows/security.flow.ts");
    expect(tree.file).toBe("flows/security.flow.ts");
  });

  it("reuses one warm project across parses (overwrite, not accumulate)", () => {
    const parser = new TsMorphParser();
    parser.parse(SOURCE);
    const second = parser.parse("export default async function other() {}");
    expect(second.sourceFile.getFunctions()[0].getName()).toBe("other");
  });

  it("update is a full re-parse at MVP", () => {
    const parser = new TsMorphParser();
    const first = parser.parse(SOURCE);
    const updated = parser.update(first, "export default async function flow2() {}", [
      { start: 0, end: SOURCE.length, newText: "export default async function flow2() {}" },
    ]);
    expect(updated.sourceFile.getFunctions()[0].getName()).toBe("flow2");
  });

  it("does not need lib files — parsing never touches the type checker", () => {
    // Referencing an unknown global would fail a type check but must parse fine.
    const tree = createParser().parse("export default async function flow() { return unknownGlobal; }");
    const body = tree.sourceFile.getFunctions()[0].getBody();
    expect(body !== undefined && Node.isBlock(body)).toBe(true);
  });
});
