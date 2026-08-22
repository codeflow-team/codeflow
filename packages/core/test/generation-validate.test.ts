/**
 * `validate` — the conformance ladder of 10-ai-codegen.md §5.
 *
 * One passing and one failing case per rung, on fixed sources: this suite is
 * deterministic and needs no network. The live-model measurement of the same
 * ladder is the eval harness (11 §3.6, `scripts/ai-eval.mjs`), which is not a
 * CI gate.
 */

import { describe, expect, it } from "vitest";

import { validateFlowSource } from "../src/generation/validate.js";
import { renderDiagnosticsFeedback } from "../src/generation/feedback.js";
import { createSampleRegistry } from "./fixtures.js";

const registry = createSampleRegistry();

function validate(source: string, allowedValueImports?: string[]) {
  return validateFlowSource(
    source,
    registry,
    allowedValueImports === undefined ? {} : { allowedValueImports },
  );
}

const HEADER = `import type { Tools } from "../generated/tools";\n`;

/** The canonical flow of 01 §1 — the reference for "map đẹp". */
const CANONICAL = `${HEADER}import { isAuthChange } from "@flows/lib";

export default async function flow(
  input: { repository: string },
  tools: Tools
) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });

  for (const pr of prs) {
    const files = await tools.github.getFiles({ pr });

    if (files.some(isAuthChange)) {
      await tools.slack.send({
        channel: "#security",
        message: \`Security PR: \${pr.title}\`
      });
    }
  }
}
`;

describe("invalid — below L0", () => {
  it("rejects a file that does not parse, before anything else is judged", () => {
    const result = validate(`${HEADER}export default async function flow(input, tools) {\n  const x = ;\n}\n`);
    expect(result.level).toBe("invalid");
    expect(result.graph).toBeNull();
    expect(result.diagnostics[0]?.code).toBe("parse-error");
    // The model has to be told *where*, or it rewrites the whole file blindly.
    expect(result.diagnostics[0]?.source?.start.line).toBe(3);
  });

  it("rejects a file with no default export", () => {
    const result = validate(`${HEADER}export async function flow(input: { a: string }, tools: Tools) {\n  await tools.slack.send({ channel: "#a", message: "b" });\n}\n`);
    expect(result.level).toBe("invalid");
    expect(result.diagnostics.some((d) => d.code === "invalid-flow-contract")).toBe(true);
  });

  it("rejects a flow function with the wrong signature", () => {
    const result = validate(`${HEADER}export default async function flow(tools: Tools) {\n  await tools.slack.send({ channel: "#a", message: "b" });\n}\n`);
    expect(result.level).toBe("invalid");
    expect(result.diagnostics.some((d) => d.code === "invalid-flow-contract")).toBe(true);
  });

  it("rejects a *value* import of a generated artifact — it has no runtime value", () => {
    const result = validate(
      `import { Tools } from "../generated/tools";

export default async function flow(input: { a: string }, tools: Tools) {
  await tools.slack.send({ channel: "#a", message: input.a });
}
`,
    );
    expect(result.level).toBe("invalid");
    const diagnostic = result.diagnostics.find((d) => d.code === "invalid-import");
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.message).toContain("import type");
  });

  it("passes the contract checks on the canonical flow", () => {
    expect(validate(CANONICAL).level).not.toBe("invalid");
  });

  it("lets a host's type checker veto — core has none of its own (10 §5)", () => {
    const typeCheck = () => [
      { severity: "error" as const, code: "type-error", message: "Type 'number' is not assignable to type 'string'." },
    ];
    expect(validateFlowSource(CANONICAL, registry, { typeCheck }).level).toBe("invalid");
    // A warning from the same hook is reported without changing the level.
    const warned = validateFlowSource(CANONICAL, registry, {
      typeCheck: () => [{ severity: "warning", code: "type-hint", message: "implicit any" }],
    });
    expect(warned.level).toBe("L2");
    expect(warned.diagnostics.some((d) => d.code === "type-hint")).toBe(true);
  });
});

describe("L0 — valid but not fully resolved", () => {
  it("drops to L0 when the model invents a tool", () => {
    const result = validate(
      `${HEADER}export default async function flow(input: { repo: string }, tools: Tools) {
  const prs = await tools.github.listPullRequests({ repo: input.repo });
  return prs;
}
`,
    );
    expect(result.level).toBe("L0");
    const diagnostic = result.diagnostics.find((d) => d.code === "unresolved-tool");
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.message).toContain("github.listPullRequests");
    expect(diagnostic?.source?.start.line).toBe(3);
  });

  it("drops to L0 when the model invents a library function", () => {
    const result = validate(
      `${HEADER}import { isSecurityRelevant } from "@flows/lib";

export default async function flow(input: { repo: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repo });
  if (prs.some(isSecurityRelevant)) {
    await tools.slack.send({ channel: "#security", message: "found" });
  }
}
`,
    );
    expect(result.level).toBe("L0");
    const diagnostic = result.diagnostics.find((d) => d.code === "unresolved-library-function");
    expect(diagnostic?.severity).toBe("error");
    // Fixable feedback: what exists is named, not just what is missing.
    expect(diagnostic?.message).toContain("isAuthChange");
  });

  it("keeps L0-and-above for an import outside the allowlist — warning, not hard fail (10 §5)", () => {
    const result = validate(
      `${HEADER}import { z } from "zod";

export default async function flow(input: { repo: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repo });
  return prs;
}
`,
    );
    expect(result.level).toBe("L2");
    const diagnostic = result.diagnostics.find((d) => d.code === "foreign-value-import");
    expect(diagnostic?.severity).toBe("warning");
    expect(diagnostic?.message).toContain("zod");
  });

  it("says nothing about an import the host allowed", () => {
    const result = validate(
      `${HEADER}import { z } from "zod";

export default async function flow(input: { repo: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repo });
  return prs;
}
`,
      ["@flows/lib", "zod"],
    );
    expect(result.diagnostics.some((d) => d.code === "foreign-value-import")).toBe(false);
  });

  it("says nothing about type-only imports from anywhere", () => {
    const result = validate(
      `${HEADER}import type { PullRequest } from "../types/github";
import { type Formatter } from "some-package";

export default async function flow(input: { repo: string }, tools: Tools) {
  const prs: PullRequest[] = await tools.github.getNewPRs({ repo: input.repo });
  return prs;
}
`,
    );
    expect(result.diagnostics.some((d) => d.code === "foreign-value-import")).toBe(false);
    expect(result.level).toBe("L2");
  });
});

describe("L1 — resolved, but the projection is lossy", () => {
  it("drops to L1 when a tool call hides inside a condition", () => {
    const result = validate(
      `${HEADER}export default async function flow(input: { repo: string }, tools: Tools) {
  if ((await tools.github.getNewPRs({ repo: input.repo })).length > 0) {
    await tools.slack.send({ channel: "#security", message: "new PRs" });
  }
}
`,
    );
    expect(result.level).toBe("L1");
    const diagnostic = result.diagnostics.find((d) => d.code === "hidden-call-in-expression");
    expect(diagnostic?.severity).toBe("warning");
    expect(diagnostic?.message).toContain("hoist");
  });

  it("points the hidden-call diagnostic at the call, not at the merged code node", () => {
    // The code node starts at line 3; the call to hoist is on line 5. Sending an
    // AI (or a human) to the top of a merged run is not a fixable diagnostic.
    const result = validate(
      `${HEADER}export default async function flow(input: { repo: string }, tools: Tools) {
  const seen = [1, 2, 3];
  const limit = seen.length;
  if ((await tools.github.getNewPRs({ repo: input.repo })).length > limit) {
    await tools.slack.send({ channel: "#security", message: "new PRs" });
  }
}
`,
    );
    const codeNode = result.graph!.nodes.find((node) => node.type === "code")!;
    expect(codeNode.source.start.line).toBe(3);
    const diagnostic = result.diagnostics.find((d) => d.code === "hidden-call-in-expression")!;
    expect(diagnostic.source?.start.line).toBe(5);
    // …while still belonging to the node it degraded.
    expect(diagnostic.source?.semanticPath).toBe(codeNode.source.semanticPath);
  });

  it("drops to L1 when logic is written inline instead of as a function", () => {
    const result = validate(
      `${HEADER}export default async function flow(input: { repo: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repo });
  const titles = prs.map((pr) => pr.title).filter((title) => title.length > 0).join(", ");
  await tools.slack.send({ channel: "#security", message: titles });
}
`,
    );
    expect(result.level).toBe("L1");
    expect(result.graph?.nodes.some((node) => node.type === "code")).toBe(true);
    const diagnostic = result.diagnostics.find((d) => d.code === "inline-logic-in-code-node");
    expect(diagnostic?.message).toContain("named function");
    expect(diagnostic?.source?.start.line).toBe(4);
  });

  it("drops to L1 when a tool result is assigned straight into an outer `let`", () => {
    // The call disappears from the graph into a code node — exactly the loss L2
    // measures, and the reason style rule 3 asks for a `const` first.
    const result = validate(
      `${HEADER}export default async function flow(input: { repo: string }, tools: Tools) {
  let prs = null;
  prs = await tools.github.getNewPRs({ repo: input.repo });
  return prs;
}
`,
    );
    expect(result.level).toBe("L1");
    expect(result.diagnostics.some((d) => d.code === "inline-logic-in-code-node")).toBe(true);
  });

  it("drops to L1 for Promise.all over a callback (the rule 2 violation models make most)", () => {
    const result = validate(
      `${HEADER}export default async function flow(input: { repo: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repo });
  const files = await Promise.all(prs.map((pr) => tools.github.getFiles({ pr })));
  return files;
}
`,
    );
    expect(result.level).toBe("L1");
    expect(result.diagnostics.some((d) => d.code === "hidden-call-in-expression")).toBe(true);
  });
});

describe("L2 — the projection is complete", () => {
  it("scores the canonical flow L2", () => {
    const result = validate(CANONICAL);
    expect(result.level).toBe("L2");
    expect(result.graph?.nodes.some((node) => node.type === "code")).toBe(false);
  });

  it("scores a bounded retry with a narrow try/catch and a parallel literal L2", () => {
    const result = validate(
      `${HEADER}export default async function flow(input: { repo: string }, tools: Tools) {
  let attempt = 0;
  let prs = null;

  while (prs === null && attempt < 3) {
    attempt = attempt + 1;
    try {
      const fetched = await tools.github.getNewPRs({ repo: input.repo });
      prs = fetched;
    } catch (error) {
      await tools.slack.send({ channel: "#alerts", message: "retrying" });
    }
  }

  if (prs === null) {
    return { sent: false };
  }

  const [first, second] = await Promise.all([
    tools.slack.send({ channel: "#a", message: "one" }),
    tools.slack.send({ channel: "#b", message: "two" })
  ]);

  return { sent: true, first, second };
}
`,
    );
    expect(result.level).toBe("L2");
    // Counters and plain assignments are plumbing: code nodes, but not defects.
    expect(result.graph?.nodes.some((node) => node.type === "code")).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "inline-logic-in-code-node")).toBe(false);
  });

  it("keeps L2 when an unbounded while only risks running forever", () => {
    // 01 §3 rule 7 is about runtime safety, not about the projection: the loop
    // still becomes a loop node, so the graph is not lying to anyone.
    const result = validate(
      `${HEADER}export default async function flow(input: { repo: string }, tools: Tools) {
  while (true) {
    await tools.slack.send({ channel: "#a", message: input.repo });
  }
}
`,
    );
    expect(result.level).toBe("L2");
    expect(result.diagnostics.some((d) => d.code === "unbounded-loop-risk")).toBe(true);
  });
});

describe("diagnostics feedback for the retry loop (10 §5)", () => {
  it("names the level reached, every error, and asks for the whole file back", () => {
    const result = validate(
      `${HEADER}export default async function flow(input: { repo: string }, tools: Tools) {
  const prs = await tools.github.listPullRequests({ repo: input.repo });
  return prs;
}
`,
    );
    const feedback = renderDiagnosticsFeedback(result);
    expect(feedback).toContain("reached L0");
    expect(feedback).toContain("unresolved-tool (line 3");
    expect(feedback).toContain("complete corrected flow file");
  });

  it("stays silent when there is nothing to fix at the target level", () => {
    expect(renderDiagnosticsFeedback(validate(CANONICAL))).toBeNull();
  });

  it("includes warnings only when the target is L2", () => {
    const result = validate(
      `${HEADER}export default async function flow(input: { repo: string }, tools: Tools) {
  if ((await tools.github.getNewPRs({ repo: input.repo })).length > 0) {
    await tools.slack.send({ channel: "#security", message: "new PRs" });
  }
}
`,
    );
    expect(renderDiagnosticsFeedback(result, { target: "L1" })).toBeNull();
    expect(renderDiagnosticsFeedback(result, { target: "L2" })).toContain(
      "hidden-call-in-expression",
    );
  });
});
