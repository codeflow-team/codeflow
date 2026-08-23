import type { Tools } from "../generated/tools";
import { scoreRisk } from "@flows/lib";

/**
 * Every way CodeFlow says "I do not know", in one file.
 *
 * Nothing here is a mistake: each statement is written to trip exactly one
 * degradation rule, so the diagnostics panel shows the whole vocabulary at
 * once. The rule the file exists to demonstrate is I6 — when the analyzer is
 * not sure, it shows a code or unknown node and says why, and it never invents
 * a node that means the wrong thing.
 *
 * This is the one example that is deliberately not type-checked: two of its
 * calls name tools no registry has.
 */

export default async function flow(
  input: { repository: string; roots: string[] },
  tools: Tools
) {
  // 1 — a real tool, resolved normally. The baseline everything else contrasts with.
  const permitted = await tools.fs.listAllowedDirectories({});

  // 2 — a tool that is not in the registry: `unknown` node + an ERROR
  //     diagnostic. The call is still shown; it is not swallowed (04 §1.2).
  const audit = await tools.fs.gitBlameEveryLine({ repo: input.repository });

  // 3 — a whole namespace nobody registered. Same rule, one level up.
  await tools.github.openIssue({ title: `Triage ${input.repository}` });

  // 4 — optional chaining on `tools`: deciding what `?.` resolves to has no
  //     bottom, so the statement is kept verbatim (`unsupported-optional-chaining`).
  const maybe = await tools.fs?.readTextFile?.({ path: `${input.roots[0]}/README.md` });

  // 5 — a tool call hidden inside a condition. The `if` does NOT become a
  //     condition node: that would hide a side effect behind a diamond
  //     (`hidden-call-in-expression`, 04 §1.4).
  if (await tools.fs.getFileInfo({ path: input.repository })) {
    await tools.memory.createEntities({
      entities: [{ name: input.repository, entityType: "repository", observations: [] }]
    });
  }

  // 6 — `Promise.all` over a `.map()`. The dynamic fan-out is outside the MVP,
  //     so it degrades rather than pretending to be a parallel node (04 §2.6).
  const scans = await Promise.all(
    input.roots.map((root) => tools.fs.directoryTree({ path: root }))
  );

  // 7 — promises hoisted into consts, then awaited together. There is no call
  //     in the `Promise.all` to make a branch out of, so this is a code node
  //     too — the regression that AI evals found (NOTES, phase 5).
  const treePromise = tools.fs.readTextFile({ path: "/etc/hostname" });
  const memoryPromise = tools.memory.readGraph({});
  const [tree, graph] = await Promise.all([treePromise, memoryPromise]);

  // 8 — a classic `for (;;)`: not a supported loop form, so the whole
  //     statement (tool call included) is one opaque code node (04 §2.5).
  for (let index = 0; index < input.roots.length; index++) {
    await tools.fs.listDirectory({ path: input.roots[index] });
  }

  // 9 — `do…while`, same answer as the classic `for`.
  let cursor = 0;
  do {
    cursor = cursor + 1;
  } while (cursor < input.roots.length);

  // 10 — a `while` whose stopping condition the analyzer cannot see:
  //      `unbounded-loop-risk`, a warning, not a refusal (04 §2.8).
  const pending = true;
  while (pending) {
    const verdict = scoreRisk(input.repository, `${permitted.content}${audit}`);
    if (verdict.level === "low") {
      await tools.memory.searchNodes({ query: verdict.reasons.join(" ") });
    }
  }

  // 11 — a `switch`: no projection rule, so it is custom code.
  switch (input.roots.length) {
    case 0:
      await tools.memory.deleteEntities({ entityNames: [input.repository] });
      break;
    default:
      await tools.memory.searchNodes({ query: input.repository });
  }

  // 12 — a tool call buried in a nested arrow, two callbacks deep.
  const nested = scans.map((scan) => () => tools.fs.writeFile({ path: "/tmp/x", content: `${scan}` }));

  // 13 — a computed tool path. What `tools["fs"]` evaluates to is a question
  //      with no static answer, so it is not resolved (I6 over convenience).
  await tools["fs"].createDirectory({ path: "/tmp/codeflow" });

  return { maybe, tree, graph, nested: nested.length, cursor };
}
