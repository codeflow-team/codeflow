import type { Tools } from "../generated/tools";
import { isAuthChange } from "@flows/lib";

export default async function flow(input: { pr: string }, tools: Tools) {
  const files = await tools.github.getFiles({ pr: input.pr });

  if (!files.some(isAuthChange)) {
    await tools.slack.send({ channel: "#security", message: "no auth change" });
  }
}
