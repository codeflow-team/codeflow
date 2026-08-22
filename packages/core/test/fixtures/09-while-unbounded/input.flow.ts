import type { Tools } from "../generated/tools";

export default async function flow(input: { channel: string }, tools: Tools) {
  let done = false;

  while (!done) {
    await tools.slack.send({ channel: input.channel, message: "ping" });
  }
}
