/**
 * Notice — the one way this UI delivers bad (or good) news.
 *
 * Shape follows 07 §5 and the copy rules in `copy.ts`: a human headline, the
 * engine's own sentence under it, and the machine detail (error code, spec
 * citation) demoted to a footnote that is there when someone needs it and
 * invisible when they do not.
 */

import type { ReactNode } from "react";
import { TriangleAlert, CircleCheck, Info, OctagonAlert, X } from "lucide-react";
import { cn } from "./cn.js";
import { splitSpecRefs } from "../copy.js";

export type NoticeTone = "danger" | "warn" | "info" | "ok" | "muted";

const TONE = {
  danger: { box: "border-danger/35 bg-danger-soft", icon: "text-danger", Icon: OctagonAlert },
  warn: { box: "border-warn/35 bg-warn-soft", icon: "text-warn", Icon: TriangleAlert },
  info: { box: "border-info/30 bg-info-soft", icon: "text-info", Icon: Info },
  ok: { box: "border-ok/30 bg-ok-soft", icon: "text-ok", Icon: CircleCheck },
  muted: { box: "border-line bg-surface-2", icon: "text-ink-faint", Icon: Info },
} as const;

export interface NoticeProps {
  tone?: NoticeTone;
  /** Human headline. Omit for a one-line notice built from `children` alone. */
  title?: ReactNode;
  children?: ReactNode;
  /** Engine error code — shown small, at the bottom, never as the headline. */
  code?: string;
  /** Spec citations lifted out of the message. */
  refs?: string[];
  /** Buttons: "Re-analyze", "Make it a template", … */
  actions?: ReactNode;
  onDismiss?: () => void;
  role?: "alert" | "status";
  className?: string;
  "data-testid"?: string;
}

export function Notice(props: NoticeProps): ReactNode {
  const tone = TONE[props.tone ?? "muted"];
  const Icon = tone.Icon;
  const footnotes = [...(props.code === undefined ? [] : [props.code]), ...(props.refs ?? [])];

  return (
    <div
      role={props.role}
      data-testid={props["data-testid"]}
      className={cn("flex gap-2.5 rounded-xl border p-3 font-sans", tone.box, props.className)}
    >
      <Icon className={cn("mt-px size-4 shrink-0", tone.icon)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {props.title === undefined ? null : (
          <p className="m-0 text-[12.5px] font-semibold leading-snug text-ink">{props.title}</p>
        )}
        {props.children === undefined ? null : (
          <div
            className={cn(
              "m-0 text-[12px] leading-[1.55] text-ink-dim",
              props.title === undefined ? "" : "mt-1",
              "[&_p]:m-0 [&_code]:font-mono [&_code]:text-[11.5px] [&_code]:text-ink",
            )}
          >
            {props.children}
          </div>
        )}
        {props.actions === undefined ? null : <div className="mt-2.5 flex flex-wrap gap-2">{props.actions}</div>}
        {footnotes.length === 0 ? null : (
          <p className="m-0 mt-2 font-mono text-[10.5px] leading-none text-ink-faint">{footnotes.join(" · ")}</p>
        )}
      </div>
      {props.onDismiss === undefined ? null : (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={props.onDismiss}
          className="m-0 -mr-1 -mt-1 h-6 w-6 shrink-0 cursor-pointer rounded-md border-0 bg-transparent p-0 text-ink-faint outline-none transition-colors hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/70"
        >
          <X className="mx-auto size-3.5" />
        </button>
      )}
    </div>
  );
}

/** `<Notice>` built straight from an engine message, citations demoted. */
export function EngineNotice(
  props: Omit<NoticeProps, "children" | "refs"> & { message: string },
): ReactNode {
  const { message, ...rest } = props;
  const split = splitSpecRefs(message);
  return (
    <Notice {...rest} refs={split.refs}>
      {split.text}
    </Notice>
  );
}
