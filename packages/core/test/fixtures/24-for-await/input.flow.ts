import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  const pages = await tools.github.pages({ repo: input.repository });

  for await (const page of pages) {
    await tools.slack.send({ channel: "#security", message: String(page) });
  }
}
