import type { Tools } from "../generated/tools";

export default async function flow(input: { repos: string[] }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repos[0] });

  outer: for (const repo of input.repos) {
    for (const pr of prs) {
      if (pr.draft) {
        continue outer;
      }
      await tools.slack.send({ channel: "#security", message: `${repo}: ${pr.title}` });
    }
  }
}
