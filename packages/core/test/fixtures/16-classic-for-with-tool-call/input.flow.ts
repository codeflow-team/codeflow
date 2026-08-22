import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });

  for (let i = 0; i < prs.length; i++) {
    await tools.github.getFiles({ pr: prs[i] });
  }
}
