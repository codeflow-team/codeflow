import type { Tools } from "../generated/tools";
import { filterAuthChanges } from "@flows/lib";

function normalize(raw: string): string {
  return raw.trim();
}

export default async function flow(input: { repository: string }, tools: Tools) {
  const repo = normalize(input.repository);
  const prs = await tools.github.getNewPRs({ repo });
  const files = await tools.github.getFiles({ pr: prs[0] });
  const flagged = filterAuthChanges(files);

  return flagged;
}
