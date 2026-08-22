import type { Tools } from "../generated/tools";

export default async function flow(input: { at: string }, tools: Tools) {
  await tools.slack.send({ channel: "#daily", message: input.at });
}
