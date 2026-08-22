import type { Tools } from "../generated/tools";

export default async function flow(input: { pr: string }, tools: Tools) {
  const files = await tools.github.getFiles({ pr: input.pr });

  if (files.length > 0) {
    const files = ["shadowed.ts"];
    await tools.slack.send({ channel: "#security", message: files[0] });
  }

  await tools.audit.log({ item: files });
}
