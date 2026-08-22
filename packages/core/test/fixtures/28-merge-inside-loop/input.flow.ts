import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });

  for (const pr of prs) {
    if (pr.draft) {
      await tools.slack.send({ channel: "#drafts", message: "draft" });
    }

    await tools.audit.log({ item: pr });
  }
}
