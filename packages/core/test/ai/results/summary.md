# AI conformance eval — 2026-08-22T19:44:29.322Z

- model: `stealth/ox-alpha`
- registry version: 1
- runs: 12 (max 2 retries, target L1, examples on)

## Conformance (final level)

| level | runs | rate |
| --- | --- | --- |
| L0 or better | 12/12 | 100% |
| L1 or better | 12/12 | 100% |
| L2 | 12/12 | 100% |

## Per intent

| intent | covers | first | final | retries |
| --- | --- | --- | --- | --- |
| security-pr-notifier#1 | for...of, if, library function, tool call, template literal | L2 | L2 | 0 |
| security-pr-notifier#2 | for...of, if, library function, tool call, template literal | L2 | L2 | 0 |
| bounded-retry#1 | while with bound, try/catch, early return | L2 | L2 | 0 |
| bounded-retry#2 | while with bound, try/catch, early return | L2 | L2 | 0 |
| parallel-digest#1 | Promise.all array literal, parallel + merge, library function | L2 | L2 | 0 |
| parallel-digest#2 | Promise.all array literal, parallel + merge, library function | L2 | L2 | 0 |
| classify-and-route#1 | if / else if / else, condition node, library function | L2 | L2 | 0 |
| classify-and-route#2 | if / else if / else, condition node, library function | L2 | L2 | 0 |
| try-catch-finally-audit#1 | try/catch/finally, error edge, narrow try | L2 | L2 | 0 |
| try-catch-finally-audit#2 | try/catch/finally, error edge, narrow try | L2 | L2 | 0 |
| loop-with-jumps#1 | for...of, continue, break, counter | L2 | L2 | 0 |
| loop-with-jumps#2 | for...of, continue, break, counter | L2 | L2 | 0 |

## Diagnostics seen (all rounds)

| diagnostic | count |
| --- | --- |
| info/unsupported-construct | 17 |

