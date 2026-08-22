/** Flow sources the demo can load. The first one is the canonical example of 01 §1. */

export interface Example {
  id: string;
  label: string;
  source: string;
}

const CANONICAL = `import type { Tools } from "../generated/tools";
import { isAuthChange } from "@flows/lib";   // library function — 05-registry.md §4

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

const TRY_CATCH = `import type { Tools } from "../generated/tools";

export default async function flow(input: { amount: number }, tools: Tools) {
  try {
    const charge = await tools.payment.charge({ amount: input.amount });
    if (charge.status === "pending") {
      return charge;
    }
  } catch (err) {
    await tools.slack.send({
      channel: "#alerts",
      message: \`Charge failed: \${err}\`
    });
  }

  return null;
}
`;

const DEGRADED = `import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  // Tool that is not in the registry → unknown node + error diagnostic (04 §1.2)
  const audit = await tools.github.getAuditLog({ repo: input.repository });

  // Unsupported construct → custom code node, source kept verbatim (04 §2.11)
  const ranked = audit.entries.filter((e) => e.risk > 3).sort((a, b) => b.risk - a.risk);

  // Hidden tool call inside a condition → whole statement degrades (04 §1.4)
  if (await tools.github.getFiles({ pr: ranked[0] })) {
    await tools.slack.send({ channel: "#security", message: "Risky change" });
  }

  let attempts = 0;
  while (somethingUnknown(attempts)) {
    attempts = attempts;
  }

  return ranked;
}
`;

/**
 * Local function + inline code node — the two opaque regions "Edit Code" can
 * replace in one patch (06 §2). `formatDigest` is a local function (its node is
 * the call, its editable region is the body); the `reduce` line is a code node.
 */
const CODE_NODES = `import type { Tools } from "../generated/tools";

function formatDigest(prs: PullRequest[]) {
  return prs.map((pr) => \`- \${pr.title}\`).join("\\n");
}

export default async function flow(input: { repository: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });

  const digest = formatDigest(prs);
  const risky = prs.filter((pr) => pr.title.length > 40).length;

  await tools.slack.send({
    channel: "#daily",
    message: \`Digest (\${risky} long titles): \${digest}\`
  });
}
`;

export const EXAMPLES: Example[] = [
  { id: "canonical", label: "Canonical (01 §1 / 07 §6)", source: CANONICAL },
  { id: "try", label: "try / catch + early return", source: TRY_CATCH },
  { id: "degraded", label: "Degradation: unknown · code · hidden call", source: DEGRADED },
  { id: "code-nodes", label: "Local function + code node (Edit Code)", source: CODE_NODES },
];
