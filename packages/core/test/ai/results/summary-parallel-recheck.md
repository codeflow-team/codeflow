# AI conformance eval — 2026-08-22T19:32:57.718Z

- model: `stealth/ox-alpha`
- registry version: 1
- runs: 3 (max 2 retries, target L1, examples on)
- duration: 129s

## Conformance (final level)

| level | runs | rate |
| --- | --- | --- |
| L0 or better | 3/3 | 100% |
| L1 or better | 3/3 | 100% |
| L2 | 3/3 | 100% |

## Per intent

| intent | covers | first | final | retries |
| --- | --- | --- | --- | --- |
| parallel-digest#1 | Promise.all array literal, parallel + merge, library function | L2 | L2 | 0 |
| parallel-digest#2 | Promise.all array literal, parallel + merge, library function | L2 | L2 | 0 |
| parallel-digest#3 | Promise.all array literal, parallel + merge, library function | L2 | L2 | 0 |

## Diagnostics seen (all rounds)

| diagnostic | count |
| --- | --- |

