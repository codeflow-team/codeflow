import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  const everything = await tools.github.listEverything({ repo: input.repository });
  await tools.slack.send({ channel: "#security", message: String(everything) });
}
