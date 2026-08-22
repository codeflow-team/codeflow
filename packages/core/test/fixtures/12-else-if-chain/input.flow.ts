import type { Tools } from "../generated/tools";

export default async function flow(input: { level: string }, tools: Tools) {
  if (input.level === "high") {
    await tools.slack.send({ channel: "#urgent", message: "high" });
  } else if (input.level === "medium") {
    await tools.slack.send({ channel: "#normal", message: "medium" });
  } else {
    await tools.slack.send({ channel: "#quiet", message: "low" });
  }

  await tools.audit.log({ item: input.level });
}
