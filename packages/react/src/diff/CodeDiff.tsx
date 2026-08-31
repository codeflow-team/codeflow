/**
 * `<CodeDiff>` — "every edit can be previewed before it is applied" (07 §5).
 *
 * A patch is a list of replaced ranges (03 §11), so the diff is shown the same
 * way: one block per range, with where it is and what it replaces. Nothing is
 * reconstructed or re-indented here — the texts are the patch engine's own, so
 * what the user reads is exactly what the source will say (I3).
 */

import type { ReactNode } from "react";
import type { TextPatch } from "@codeflow-team/core";
import { cn } from "../ui/cn.js";

export interface CodeDiffProps {
  patches: readonly TextPatch[];
  /** Shown when `patches` is empty — an empty edit changes nothing (I4). */
  emptyLabel?: string;
  className?: string;
}

function lines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\n$/, "").split("\n");
}

function where(patch: TextPatch): string {
  const { start, end } = patch.range;
  const from = `${String(start.line)}:${String(start.column)}`;
  return start.line === end.line && start.column === end.column
    ? from
    : `${from}–${String(end.line)}:${String(end.column)}`;
}

export function CodeDiff(props: CodeDiffProps): ReactNode {
  if (props.patches.length === 0) {
    return (
      <p className={cn("m-0 text-[11.5px] italic text-ink-faint", props.className)}>
        {props.emptyLabel ?? "No change — the file would not move by a single character."}
      </p>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", props.className)} data-testid="code-diff">
      {props.patches.map((patch, i) => (
        <div className="overflow-hidden rounded-lg border border-line bg-surface" key={i}>
          <div className="border-b border-line bg-surface-2 px-2.5 py-1 font-mono text-[10.5px] text-ink-faint">
            line {where(patch)}
          </div>
          <pre className="cf-scroll m-0 flex flex-col overflow-x-auto py-1 font-mono text-[11.5px] leading-[1.55]">
            {lines(patch.oldText).map((line, j) => (
              <span
                className="whitespace-pre bg-danger-soft px-2.5 text-danger"
                key={`o${String(j)}`}
              >
                {`- ${line}`}
              </span>
            ))}
            {lines(patch.newText).map((line, j) => (
              <span className="whitespace-pre bg-ok-soft px-2.5 text-ok" key={`n${String(j)}`}>
                {`+ ${line}`}
              </span>
            ))}
            {patch.oldText.length === 0 && patch.newText.length === 0 ? (
              <span className="px-2.5 text-ink-faint">(empty)</span>
            ) : null}
          </pre>
        </div>
      ))}
    </div>
  );
}
