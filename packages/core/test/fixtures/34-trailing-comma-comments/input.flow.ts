import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });

  await tools.slack.send({
    channel: "#security", // where the alert goes
    message: `Found ${prs.length} PRs`,
    urgent: true,
  });
}
