import type { Tools } from "../generated/tools";

export default async function flow(input: { channel: string }) {
  const target = input.channel;
  return target;
}
