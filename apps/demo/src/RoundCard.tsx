/**
 * One validation round, drawn.
 *
 * The retry loop of 10 §5 is the most convincing thing this demo does, and it is
 * now watched from two places — the chat panel and the create dialog — so the
 * card that shows a round lives on its own rather than being copied into the
 * second one. Level, counts, the deduplicated diagnostics and the time: exactly
 * what `generate-flow.ts` reports, nothing added.
 *
 * The list is deduplicated with a count and carries line numbers, because the
 * first version repeated an identical sentence six times, then said "+25 more",
 * and headed the whole thing "10 warnings" (QA BUG-12). Numbers that do not add
 * up teach a reader to ignore the panel.
 */

import { useMemo, type ReactNode } from "react";
import type { Diagnostic } from "@codeflow-team/core";
import { Badge, cn } from "@codeflow-team/react";
import type { GenerationRound } from "./generate-flow.js";

export function RoundCard({ round, compact }: { round: GenerationRound; compact?: boolean }): ReactNode {
  const grouped = useMemo(() => {
    const byMessage = new Map<string, { diagnostic: Diagnostic; count: number; lines: number[] }>();
    for (const diagnostic of round.diagnostics) {
      const key = `${diagnostic.code} ${diagnostic.message}`;
      const line = diagnostic.source?.start.line;
      const entry = byMessage.get(key);
      if (entry === undefined) {
        byMessage.set(key, { diagnostic, count: 1, lines: line === undefined ? [] : [line] });
      } else {
        entry.count += 1;
        if (line !== undefined) entry.lines.push(line);
      }
    }
    return [...byMessage.values()].sort((a, b) => severityRank(a.diagnostic) - severityRank(b.diagnostic));
  }, [round.diagnostics]);

  const counts = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of round.diagnostics) counts[diagnostic.severity] += 1;
  const good = round.level === "L1" || round.level === "L2";
  const limit = compact === true ? 4 : 8;

  return (
    <div className="rounded-lg border border-line bg-surface-2 px-2.5 py-2" data-testid="chat-round">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium text-ink-dim">Round {round.round}</span>
        <Badge tone={good ? "ok" : round.level === "L0" ? "warn" : "danger"} title="Conformance level (10 §5)">
          {round.level}
        </Badge>
        {counts.error > 0 ? <Badge tone="danger">{counts.error} error{counts.error === 1 ? "" : "s"}</Badge> : null}
        {counts.warning > 0 ? <Badge tone="warn">{counts.warning} warning{counts.warning === 1 ? "" : "s"}</Badge> : null}
        {counts.info > 0 ? <Badge tone="neutral">{counts.info} note{counts.info === 1 ? "" : "s"}</Badge> : null}
        <span className="ml-auto text-[10.5px] tabular-nums text-ink-faint">
          {(round.ms / 1000).toFixed(1)}s
        </span>
      </div>
      {grouped.length === 0 ? null : (
        <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
          {grouped.slice(0, limit).map((entry, i) => (
            <li key={i} className="flex gap-1.5 text-[10.5px] leading-snug text-ink-dim">
              <span
                className={cn(
                  "mt-[5px] size-1.5 shrink-0 rounded-full",
                  entry.diagnostic.severity === "error"
                    ? "bg-danger"
                    : entry.diagnostic.severity === "warning"
                      ? "bg-warn"
                      : "bg-info",
                )}
              />
              <span className="min-w-0">
                <span className="font-mono">{entry.diagnostic.code}</span>
                {entry.lines.length === 0 ? null : (
                  <span className="font-mono text-ink-faint"> · {formatLines(entry.lines)}</span>
                )}
                {entry.count === 1 ? null : <span className="text-ink-faint"> · ×{entry.count}</span>}{" "}
                — {entry.diagnostic.message}
              </span>
            </li>
          ))}
          {grouped.length > limit ? (
            <li className="text-[10.5px] text-ink-faint">
              +{grouped.length - limit} more kind{grouped.length - limit === 1 ? "" : "s"} of issue
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

function severityRank(diagnostic: Diagnostic): number {
  return diagnostic.severity === "error" ? 0 : diagnostic.severity === "warning" ? 1 : 2;
}

function formatLines(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const shown = sorted.slice(0, 4).map((line) => String(line)).join(", ");
  return sorted.length > 4 ? `lines ${shown}, …` : sorted.length === 1 ? `line ${shown}` : `lines ${shown}`;
}
