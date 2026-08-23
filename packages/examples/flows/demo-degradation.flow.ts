import type { Tools } from "../generated/tools";

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
