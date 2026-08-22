import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  const { data, error } = await tools.github.fetchRepo({ repo: input.repository });
  await tools.slack.send({ channel: "#security", message: `${data} ${error}` });
}
