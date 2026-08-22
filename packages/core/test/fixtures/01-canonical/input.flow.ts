import type { Tools } from "../generated/tools";
import { isAuthChange } from "@flows/lib";

export default async function flow(input: { repository: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });

  for (const pr of prs) {
    const files = await tools.github.getFiles({ pr });

    if (files.some(isAuthChange)) {
      await tools.slack.send({
        channel: "#security",
        message: `Security PR: ${pr.title}`
      });
    }
  }
}
