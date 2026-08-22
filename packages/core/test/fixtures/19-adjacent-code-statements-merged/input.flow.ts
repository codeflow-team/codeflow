import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  const now = Date.now();
  const runLabel = `run-${now}`;
  const parts = runLabel.split("-");

  await tools.slack.send({ channel: "#audit", message: parts[0] });
}
