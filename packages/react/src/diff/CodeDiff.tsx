/**
 * `<CodeDiff>` — "every edit can be previewed before it is applied" (07 §5).
 *
 * A patch is a list of replaced ranges (03 §11), so the diff is shown the same
 * way: one block per range, with where it is and what it replaces. Nothing is
 * reconstructed or re-indented here — the texts are the patch engine's own, so
 * what the user reads is exactly what the source will say (I3).
 */

import type { ReactNode } from "react";
import type { TextPatch } from "@codeflow/core";

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
      <p className={`cf-diff cf-diff--empty ${props.className ?? ""}`}>
        {props.emptyLabel ?? "No change — the source would not move by a single byte."}
      </p>
    );
  }

  return (
    <div className={`cf-diff ${props.className ?? ""}`} data-testid="code-diff">
      {props.patches.map((patch, i) => (
        <div className="cf-diff__patch" key={i}>
          <div className="cf-diff__where">line {where(patch)}</div>
          <pre className="cf-diff__body">
            {lines(patch.oldText).map((line, j) => (
              <span className="cf-diff__line cf-diff__line--old" key={`o${String(j)}`}>
                {`- ${line}`}
              </span>
            ))}
            {lines(patch.newText).map((line, j) => (
              <span className="cf-diff__line cf-diff__line--new" key={`n${String(j)}`}>
                {`+ ${line}`}
              </span>
            ))}
            {patch.oldText.length === 0 && patch.newText.length === 0 ? (
              <span className="cf-diff__line">(empty)</span>
            ) : null}
          </pre>
        </div>
      ))}
    </div>
  );
}
