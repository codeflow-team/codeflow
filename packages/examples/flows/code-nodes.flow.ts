import type { Tools } from "../generated/tools";

function formatDigest(prs: { title: string }[]) {
  return prs.map((pr) => `- ${pr.title}`).join("\n");
}

export default async function flow(input: { repository: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });

  const digest = formatDigest(prs);
  const risky = prs.filter((pr) => pr.title.length > 40).length;

  await tools.slack.send({
    channel: "#daily",
    message: `Digest (${risky} long titles): ${digest}`
  });
}
