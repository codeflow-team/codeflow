import type { Tools } from "../generated/tools";

export default async function flow(input: { id: string }, tools: Tools) {
  const pr = await tools.github.getPR({ id: input.id });

  if (!pr) {
    return null;
  }

  await tools.slack.send({ channel: "#security", message: `${pr.title}` });
  return pr;
}
