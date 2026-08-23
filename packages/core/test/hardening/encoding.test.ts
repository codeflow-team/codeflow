/**
 * Encoding and file-format hazards — the ones that turn "byte-for-byte" (I3)
 * from a slogan into a claim someone has checked.
 *
 * Every case here is a real file a real repository can contain: written on
 * Windows, opened by an editor that adds a BOM, indented with tabs, holding a
 * name in a script that is not ASCII. The bug they all catch is the same one —
 * a coordinate space or a byte that the pipeline quietly normalises away — and
 * it is invisible until the file it happens to is yours.
 */

import { describe, expect, it } from "vitest";

import { createSampleRegistry } from "../fixtures.js";
import { renderStringLiteral } from "../../src/patcher/values.js";
import { FILE, flowSource, nodeAt, open, refusal, threeFieldRegistry, toolNode } from "./helpers.js";

const BOM = "﻿";

function crlf(source: string): string {
  return source.replace(/\n/g, "\r\n");
}

/* -------------------------------------------------------------------------- */
/* line endings                                                                */
/* -------------------------------------------------------------------------- */

describe("CRLF files stay CRLF", () => {
  const source = crlf(
    flowSource(
      `  await tools.slack.send({
    channel: "#security",
    message: \`PR: \${input.repository}\`
  });`,
    ),
  );

  it("analyzes a CRLF file into the same graph shape as its LF twin", async () => {
    const { graph } = await open(source);
    expect(graph.nodes.map((node) => node.source.semanticPath)).toEqual([
      "flow#trigger",
      "flow/call:slack.send[0]",
      "flow#output",
    ]);
    // Ranges are offsets into the CRLF text, so slicing has to give the call back.
    const node = nodeAt(graph, "flow/call:slack.send[0]");
    expect(source.slice(node.source.start.offset, node.source.end.offset)).toContain("tools.slack.send");
  });

  it("edits one field without converting a single line ending", async () => {
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, {
      channel: "#engineering",
    });
    expect(result.source).toBe(source.replace('"#security"', '"#engineering"'));
    expect(result.source.includes("\r\n")).toBe(true);
    // No stray LF: every \n in the result is preceded by \r.
    expect(/(?<!\r)\n/.test(result.source)).toBe(false);
  });

  it("removes a property together with its CRLF, not just its LF", async () => {
    const three = crlf(
      flowSource(
        `  await tools.slack.send({
    channel: "#security",
    message: "m",
    thread: "t"
  });`,
      ),
    );
    const { session, graph } = await open(three, threeFieldRegistry());
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, {
      message: { kind: "remove" },
    });
    expect(result.source).toBe(three.replace('    message: "m",\r\n', ""));
    expect(/(?<!\r)\n/.test(result.source)).toBe(false);
  });

  it("inserts a new statement with CRLF, matching the file it lands in", async () => {
    const source2 = crlf(
      flowSource(
        `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  return prs;`,
      ),
    );
    const { session, graph } = await open(source2);
    const result = await session.patchNode(nodeAt(graph, "flow/call:github.getNewPRs[0]").id, {
      $insert: { tool: "slack.send", where: "after" },
    });
    expect(/(?<!\r)\n/.test(result.source)).toBe(false);
    expect(result.source).toContain("await tools.slack.send(");
  });

  it("keeps the file byte-identical when the edit changes nothing (I4)", async () => {
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, {
      channel: "#security",
    });
    expect(result.patches).toEqual([]);
    expect(result.source).toBe(source);
  });
});

/* -------------------------------------------------------------------------- */
/* byte-order mark                                                             */
/* -------------------------------------------------------------------------- */

describe("a leading BOM does not shift the coordinate space", () => {
  const plain = flowSource(`  await tools.slack.send({ channel: "#security", message: "m" });`);
  const withBom = BOM + plain;

  it("maps every node onto the text it actually covers", async () => {
    // Regression: ts-morph strips a leading BOM from the text it parses, so
    // every AST offset sat one character ahead of the source the caller held.
    // Node ranges came back one character short (`" await tools…"`), the UI
    // highlighted the wrong span, and every patch was rejected as unparseable.
    const { graph } = await open(withBom);
    for (const node of graph.nodes) {
      const text = withBom.slice(node.source.start.offset, node.source.end.offset);
      // A shifted coordinate space shows up as a leading space on every range.
      expect(text).toBe(text.replace(/^\s+/, ""));
    }
    const node = nodeAt(graph, "flow/call:slack.send[0]");
    expect(withBom.slice(node.source.start.offset, node.source.end.offset)).toBe(
      'await tools.slack.send({ channel: "#security", message: "m" });',
    );
  });

  it("produces the same graph shape as the same file without a BOM", async () => {
    const withoutBom = await open(plain);
    const bommed = await open(withBom);
    expect(bommed.graph.nodes.map((node) => node.source.semanticPath)).toEqual(
      withoutBom.graph.nodes.map((node) => node.source.semanticPath),
    );
    // Offsets are one apart, because the file genuinely is one character longer.
    expect(nodeAt(bommed.graph, "flow/call:slack.send[0]").source.start.offset).toBe(
      nodeAt(withoutBom.graph, "flow/call:slack.send[0]").source.start.offset + 1,
    );
  });

  it("patches a field and keeps the BOM", async () => {
    const { session, graph } = await open(withBom);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, {
      channel: "#engineering",
    });
    expect(result.source.charCodeAt(0)).toBe(0xfeff);
    expect(result.source).toBe(withBom.replace('"#security"', '"#engineering"'));
    expect(result.patches).toHaveLength(1);
  });

  it("round-trips: re-analyzing the patched BOM file keeps every id", async () => {
    const { session, graph } = await open(withBom);
    const before = graph.nodes.map((node) => node.id);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, {
      channel: "#engineering",
    });
    expect(result.graph.nodes.map((node) => node.id)).toEqual(before);
    const again = await session.analyze(result.source, { file: FILE });
    expect(again.nodes.map((node) => node.id)).toEqual(before);
  });

  it("handles a BOM on a CRLF file — both hazards at once", async () => {
    const both = BOM + crlf(plain);
    const { session, graph } = await open(both);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, {
      channel: "#engineering",
    });
    expect(result.source).toBe(both.replace('"#security"', '"#engineering"'));
    expect(result.source.charCodeAt(0)).toBe(0xfeff);
    expect(/(?<!\r)\n/.test(result.source)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* indentation                                                                 */
/* -------------------------------------------------------------------------- */

describe("indentation is observed, never imposed", () => {
  const tabbed = `import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
\tawait tools.slack.send({
\t\tchannel: "#security",
    message: "m"
\t});
}
`;

  it("edits a field in a tab-indented file with spaces mixed in", async () => {
    const { session, graph } = await open(tabbed);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, {
      channel: "#engineering",
    });
    // The mixed indentation is untouched: only the value changed.
    expect(result.source).toBe(tabbed.replace('"#security"', '"#engineering"'));
  });

  it("adds a property using the indentation of the property above it", async () => {
    const source = `import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
\tawait tools.slack.send({
\t\tchannel: "#security"
\t});
}
`;
    const { session, graph } = await open(source, threeFieldRegistry());
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, { message: "m" });
    expect(result.source).toContain('\t\tchannel: "#security",\n\t\tmessage: "m"\n');
  });

  it("survives a 5000-character line", async () => {
    const long = "x".repeat(5000);
    const source = flowSource(`  await tools.slack.send({ channel: "#security", message: "${long}" });`);
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, { channel: "#eng" });
    expect(result.source).toBe(source.replace('"#security"', '"#eng"'));
    expect(result.patches[0].range.start.line).toBe(4);
    expect(result.patches[0].range.start.column).toBe(37);
  });
});

/* -------------------------------------------------------------------------- */
/* text content: unicode and escapes                                           */
/* -------------------------------------------------------------------------- */

describe("string content survives the round trip", () => {
  it("keeps CJK and emoji in an untouched sibling field", async () => {
    const source = flowSource(
      '  await tools.slack.send({ channel: "#security", message: "安全 PR 🎉 — 検証済み" });',
    );
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, { channel: "#eng" });
    expect(result.source).toContain('message: "安全 PR 🎉 — 検証済み"');
    expect(result.source).toBe(source.replace('"#security"', '"#eng"'));
  });

  it("keeps CJK and emoji in a comment next to the edit", async () => {
    const source = flowSource(
      `  // 送信先: セキュリティチャンネル 🔐 (do not touch)
  await tools.slack.send({ channel: "#security", message: "m" });`,
    );
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, { channel: "#eng" });
    expect(result.source).toContain("// 送信先: セキュリティチャンネル 🔐 (do not touch)");
  });

  it("writes a ZWJ emoji sequence as itself, not as escapes or surrogates", async () => {
    // A family emoji is four code points joined by U+200D, seven UTF-16 units.
    // Anything that walks the string by unit rather than by code point tears it.
    const family = "👨‍👩‍👧‍👦";
    const source = flowSource('  await tools.slack.send({ channel: "#security", message: "m" });');
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, {
      channel: `#${family}-家族`,
    });
    expect(result.source).toContain(`channel: "#${family}-家族"`);
    expect([...(result.source.match(/‍/g) ?? [])]).toHaveLength(3);

    const { graph: after } = await open(result.source);
    expect((after.nodes.find((n) => n.type === "tool")!.data["arguments"] as Record<string, string>)["channel"]).toBe(
      `"#${family}-家族"`,
    );
  });

  it("re-escapes a value that contains newlines, tabs, backslashes and quotes", async () => {
    const source = flowSource('  await tools.slack.send({ channel: "a\\nb", message: "m" });');
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, {
      channel: 'x\ny\tz\\w"v',
    });
    // Every one of these characters is escaped rather than written raw — a raw
    // TAB inside a literal is invisible and is exactly what an editor's
    // trim-on-save silently rewrites, changing the value behind the user.
    expect(result.source).toContain('channel: "x\\ny\\tz\\\\w\\"v"');
    const { graph: after } = await open(result.source);
    expect(after.nodes.some((node) => node.type === "code")).toBe(false);
  });

  it("escapes only the delimiter in use — a single-quoted file keeps single quotes", () => {
    expect(renderStringLiteral(`he said "hi"`, "'")).toBe(`'he said "hi"'`);
    expect(renderStringLiteral(`it's`, "'")).toBe(`'it\\'s'`);
    expect(renderStringLiteral(`it's`, '"')).toBe(`"it's"`);
  });

  it("escapes the line/paragraph separators and other control characters", () => {
    expect(renderStringLiteral("a b c", '"')).toBe('"a\\u2028b\\u2029c"');
    expect(renderStringLiteral("a bc", '"')).toBe('"a\\u0000b\\u0007c"');
    expect(renderStringLiteral("a\bb\fc\vd", '"')).toBe('"a\\bb\\fc\\vd"');
  });

  it("never promotes a string literal to a template, even when the text holds `${`", async () => {
    const source = flowSource('  await tools.slack.send({ channel: "#security", message: "m" });');
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, {
      channel: "${input.repository}",
    });
    // Still a string literal: the `${` is text, not an interpolation (06 §3).
    expect(result.source).toContain('channel: "${input.repository}"');
    const { graph: after } = await open(result.source);
    expect((toolNode(after, "slack.send").data["arguments"] as Record<string, string>)["channel"]).toBe(
      '"${input.repository}"',
    );
  });

  it("leaves a string that already contains `${`, `}}` and escaped backticks alone", async () => {
    const source = flowSource(
      '  await tools.slack.send({ channel: "#security", message: "${a}} \\`tick\\`" });',
    );
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, { channel: "#eng" });
    expect(result.source).toBe(source.replace('"#security"', '"#eng"'));
  });
});

/* -------------------------------------------------------------------------- */
/* determinism across all of the above                                         */
/* -------------------------------------------------------------------------- */

describe("determinism holds for every encoding (I2)", () => {
  const variants: Record<string, string> = {
    lf: flowSource('  await tools.slack.send({ channel: "#security", message: "m" });'),
    crlf: crlf(flowSource('  await tools.slack.send({ channel: "#security", message: "m" });')),
    bom: BOM + flowSource('  await tools.slack.send({ channel: "#security", message: "m" });'),
    unicode: flowSource('  await tools.slack.send({ channel: "#安全-🔐", message: "m" });'),
  };

  for (const [name, source] of Object.entries(variants)) {
    it(`analyzes ${name} identically twice, cold`, async () => {
      const first = await open(source, createSampleRegistry());
      const second = await open(source, createSampleRegistry());
      expect(second.graph.nodes.map((node) => node.id)).toEqual(first.graph.nodes.map((node) => node.id));
      expect(second.graph.source.contentHash).toBe(first.graph.source.contentHash);
    });
  }

  it("gives a BOM'd file a different content hash from its BOM-free twin", async () => {
    // The BOM is a byte of the document, and staleness detection compares
    // documents — collapsing the two would make a real change look like none.
    const a = await open(variants["lf"]);
    const b = await open(variants["bom"]);
    expect(b.graph.source.contentHash).not.toBe(a.graph.source.contentHash);
    expect(b.graph.source.content).toBe(variants["bom"]);
  });

  it("still refuses an impossible edit on an exotic file without touching it", async () => {
    const source = BOM + crlf(flowSource('  await tools.slack.send({ channel: "#security", message: "m" });'));
    const { session, graph } = await open(source);
    const error = await refusal(
      session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, { nope: "x" }),
    );
    expect(error.code).toBe("patch-not-editable");
    expect(graph.source.content).toBe(source);
  });
});
