# AI conformance eval — 2026-08-22T19:40:37.949Z

- model: `stealth/ox-alpha`
- registry version: 1
- runs: 6 (max 2 retries, target L1, examples off)
- duration: 430s

## Conformance (final level)

| level | runs | rate |
| --- | --- | --- |
| L0 or better | 6/6 | 100% |
| L1 or better | 6/6 | 100% |
| L2 | 6/6 | 100% |

## Per intent

| intent | covers | first | final | retries |
| --- | --- | --- | --- | --- |
| security-pr-notifier | for...of, if, library function, tool call, template literal | L2 | L2 | 0 |
| bounded-retry | while with bound, try/catch, early return | L2 | L2 | 0 |
| parallel-digest | Promise.all array literal, parallel + merge, library function | L2 | L2 | 0 |
| classify-and-route | if / else if / else, condition node, library function | L2 | L2 | 0 |
| try-catch-finally-audit | try/catch/finally, error edge, narrow try | L2 | L2 | 0 |
| loop-with-jumps | for...of, continue, break, counter | L2 | L2 | 0 |

## Diagnostics seen (all rounds)

| diagnostic | count |
| --- | --- |
| info/unsupported-construct | 11 |

