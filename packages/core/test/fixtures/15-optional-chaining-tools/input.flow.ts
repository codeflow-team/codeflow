import type { Tools } from "../generated/tools";

export default async function flow(input: { pr: string }, tools: Tools) {
  const files = await tools.github?.getFiles?.({ pr: input.pr });
  await tools.slack.send({ channel: "#security", message: String(files) });
}
