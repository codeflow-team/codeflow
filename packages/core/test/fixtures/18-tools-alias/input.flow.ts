import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  const t = tools;
  const prs = await t.github.getNewPRs({ repo: input.repository });

  for (const pr of prs) {
    const tools = { github: { getFiles: async (arg: { pr: unknown }) => [arg.pr] } };
    const files = await tools.github.getFiles({ pr });
    await t.slack.send({ channel: "#security", message: String(files.length) });
  }
}
