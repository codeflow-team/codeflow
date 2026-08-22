import type { Tools } from "../generated/tools";

export function helper(raw: string) {
  return raw.trim();
}

export const VERSION = "1.0.0";

export default async function flow(input: { channel: string }, tools: Tools) {
  await tools.slack.send({ channel: input.channel, message: helper("  hi  ") });
}
