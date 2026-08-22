import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });
  const allFiles = await Promise.all(prs.map((pr) => tools.github.getFiles({ pr })));
  await tools.slack.send({ channel: "#security", message: String(allFiles.length) });
}
