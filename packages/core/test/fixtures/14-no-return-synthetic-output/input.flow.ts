import type { Tools } from "../generated/tools";

export default async function flow(input: { channel: string }, tools: Tools) {
  await tools.slack.send({ channel: input.channel, message: "hello" });
}
