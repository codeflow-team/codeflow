import type { Tools } from "../generated/tools";

export default async function flow(input: { pr: string }, tools: Tools) {
  if (await tools.github.hasLabel({ pr: input.pr })) {
    await tools.slack.send({ channel: "#security", message: "labeled" });
  }
}
