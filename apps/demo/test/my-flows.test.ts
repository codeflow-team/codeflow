/**
 * The visitor's own flows — the parts that are not React.
 *
 * The one claim worth a test rather than a screenshot is the blank flow: "start
 * blank" is only worth offering if what it produces is a *valid* flow, and 07 §5
 * would rather have no button than a button that opens an error. So it is put
 * through the same `validateFlowSource` the generation loop uses and has to come
 * back at the target level with nothing on the diagnostics list.
 */

import { describe, expect, it } from "vitest";
import { validateFlowSource } from "@codeflow/core";
import { REGISTRIES } from "@codeflow/examples";
import { registryInstance } from "../src/registry.js";
import {
  MCP_REGISTRY,
  asExample,
  blankFlowSource,
  countLines,
  exportFlowFile,
  fileNameFor,
  isMine,
  newFlowId,
  parseFlowFile,
  registryLabelFor,
  suggestTitle,
  uniqueTitle,
  type MyFlow,
} from "../src/my-flows.js";

function flow(overrides: Partial<MyFlow> = {}): MyFlow {
  return {
    id: newFlowId(),
    title: "A flow",
    source: blankFlowSource(),
    registryChoice: "sample",
    createdAt: 1,
    updatedAt: 1,
    origin: null,
    prompt: null,
    generation: null,
    ...overrides,
  };
}

describe("blankFlowSource", () => {
  it("is a valid flow file against every built-in registry", () => {
    for (const [id, registry] of Object.entries(REGISTRIES)) {
      const result = validateFlowSource(blankFlowSource(), registryInstance(registry));
      expect(result.level, `registry ${id}`).toBe("L2");
      expect(
        result.diagnostics.filter((diagnostic) => diagnostic.severity !== "info"),
        `registry ${id}`,
      ).toEqual([]);
    }
  });

  it("declares a trigger type, so the run form has something to show", () => {
    expect(blankFlowSource()).toContain("input: { message: string }");
  });

  it("calls no tool, so nothing has to be deleted before a real step is added", () => {
    expect(blankFlowSource()).not.toContain("await tools.");
  });
});

describe("asExample", () => {
  it("wears the FlowExample shape and carries the record", () => {
    const mine = flow({ title: "Nightly digest", prompt: "post a digest every night" });
    const example = asExample(mine);
    expect(example.id).toBe(mine.id);
    expect(example.title).toBe("Nightly digest");
    expect(example.source).toBe(mine.source);
    expect(example.lines).toBe(countLines(mine.source));
    expect(isMine(example)).toBe(true);
    expect(example.mine).toBe(mine);
  });

  it("never names a registry that does not exist, even for an MCP flow", () => {
    const example = asExample(flow({ registryChoice: MCP_REGISTRY }));
    expect(Object.keys(REGISTRIES)).toContain(example.registryId);
    // …while the record still says what was actually chosen.
    expect(example.mine.registryChoice).toBe(MCP_REGISTRY);
  });

  it("is not mistaken for a built-in example", () => {
    const [first] = Object.values(REGISTRIES);
    expect(first).toBeDefined();
    expect(isMine({ id: "canonical" } as never)).toBe(false);
  });
});

describe("registryLabelFor", () => {
  it("names the visitor's servers for the MCP choice", () => {
    expect(registryLabelFor(MCP_REGISTRY)).toBe("Your MCP servers");
  });

  it("uses the registry's own label when there is one", () => {
    expect(registryLabelFor("sample")).toBe(REGISTRIES["sample"]?.label);
  });

  it("falls back to the id rather than inventing a name", () => {
    expect(registryLabelFor("not-a-registry")).toBe("not-a-registry");
  });
});

describe("suggestTitle", () => {
  it("uses the words that carry meaning", () => {
    expect(suggestTitle("For every new pull request, post its title to #releases")).toBe(
      "New pull request post title",
    );
  });

  it("falls back rather than producing an empty name", () => {
    expect(suggestTitle("the a of to")).toBe("Untitled flow");
  });

  it("does not collide with a name already taken", () => {
    const taken = [flow({ title: "Untitled flow" })];
    expect(suggestTitle("of the", taken)).toBe("Untitled flow 2");
  });
});

describe("uniqueTitle", () => {
  it("leaves a free name alone", () => {
    expect(uniqueTitle("Digest", [])).toBe("Digest");
  });

  it("counts up, case-insensitively", () => {
    const taken = [flow({ title: "Digest" }), flow({ title: "digest 2" })];
    expect(uniqueTitle("Digest", taken)).toBe("Digest 3");
  });
});

describe("export / import", () => {
  it("round-trips the name, the registry and the source byte for byte", () => {
    const mine = flow({ title: "Nightly digest", registryChoice: "research", source: "export default async function flow() {}\n" });
    const file = exportFlowFile(mine);
    const back = parseFlowFile(file, "nightly-digest.flow.ts");
    expect(back.title).toBe("Nightly digest");
    expect(back.registryChoice).toBe("research");
    expect(back.source).toBe(mine.source);
  });

  it("keeps the file compilable — everything but the source is a comment", () => {
    const file = exportFlowFile(flow({ source: "export default async function flow() {}\n" }));
    expect(file.startsWith("/* codeflow:flow ")).toBe(true);
    expect(file.split("\n")[1]).toBe("export default async function flow() {}");
  });

  it("does not stack headers when an exported file is exported again", () => {
    const once = exportFlowFile(flow({ source: "export default async function flow() {}\n" }));
    const twice = exportFlowFile(flow({ source: once }));
    expect(twice.split("\n").filter((line) => line.startsWith("/* codeflow:flow"))).toHaveLength(1);
  });

  it("accepts a hand-written flow file with no header at all", () => {
    const back = parseFlowFile("export default async function flow() {}\n", "my_cool-flow.flow.ts");
    expect(back.title).toBe("my cool flow");
    expect(back.registryChoice).toBeNull();
    expect(back.source).toBe("export default async function flow() {}\n");
  });

  it("ignores a header it cannot read rather than losing the file", () => {
    const back = parseFlowFile("/* codeflow:flow {not json} */\nconst a = 1;\n", "x.flow.ts");
    expect(back.title).toBeNull();
    expect(back.source).toBe("const a = 1;\n");
  });

  it("names the download after the flow", () => {
    expect(fileNameFor({ title: "Nightly Digest — v2" })).toBe("nightly-digest-v2.flow.ts");
    expect(fileNameFor({ title: "…" })).toBe("flow.flow.ts");
  });
});
