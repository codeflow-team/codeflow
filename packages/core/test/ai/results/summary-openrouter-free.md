# AI conformance eval — 2026-08-31T17:13:54.608Z

- model: `openrouter/free`
- registry version: 1
- runs: 6 (max 1 retries, target L1, examples on)
- duration: 262s

## Conformance (final level)

| level | runs | rate |
| --- | --- | --- |
| L0 or better | 6/6 | 100% |
| L1 or better | 6/6 | 100% |
| L2 | 5/6 | 83% |

## Per intent

| intent | covers | first | final | retries |
| --- | --- | --- | --- | --- |
| security-pr-notifier | for...of, if, library function, tool call, template literal | L2 | L2 | 0 |
| bounded-retry | while with bound, try/catch, early return | L0 | L1 | 1 |
| parallel-digest | Promise.all array literal, parallel + merge, library function | L2 | L2 | 0 |
| classify-and-route | if / else if / else, condition node, library function | L2 | L2 | 0 |
| try-catch-finally-audit | try/catch/finally, error edge, narrow try | L2 | L2 | 0 |
| loop-with-jumps | for...of, continue, break, counter | invalid | L2 | 1 |

## Diagnostics seen (all rounds)

| diagnostic | count |
| --- | --- |
| info/unsupported-construct | 10 |
| warning/hidden-call-in-expression | 2 |
| warning/inline-logic-in-code-node | 2 |
| error/unresolved-library-function | 1 |
| error/parse-error | 1 |

## What kept a run below L2

### bounded-retry — L1

- hidden-call-in-expression (line 13): `await tools.jira.getIssue({ key: input.issueKey })` is awaited/called inside an expression — hoist it into its own `const` so it becomes a node (04 §1.4).
- inline-logic-in-code-node (line 13): `tools.jira.getIssue({ key: input.issueKey })` runs inside a custom code node, so the step is invisible on the graph. Give the call its own `const x = await …` statement if it is a tool, or move the logic into a named function and call that (01 §3 rules 4–5).
- inline-logic-in-code-node (line 25): `setTimeout(resolve, 1000)` runs inside a custom code node, so the step is invisible on the graph. Give the call its own `const x = await …` statement if it is a tool, or move the logic into a named function and call that (01 §3 rules 4–5).


