import type { Tools } from "../generated/tools";

export default async function flow(input: { urgent: boolean }, tools: Tools) {
  let channel = "#general";

  if (input.urgent) {
    channel = "#urgent";
  } else {
    channel = "#quiet";
  }

  await tools.slack.send({ channel, message: "routed" });
}
