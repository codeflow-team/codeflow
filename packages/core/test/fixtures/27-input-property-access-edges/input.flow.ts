import type { Tools } from "../generated/tools";

export default async function flow(
  input: { repository: string; channel: string },
  tools: Tools
) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: input.channel, message: String(prs.length) });
}
