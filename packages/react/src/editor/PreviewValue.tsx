/**
 * `<PreviewValue>` — one value, drawn through the renderer seam.
 *
 * Host renderers get first refusal (in their own order); the built-in JSON/text
 * renderer is what draws everything else, so a value is never rendered as
 * nothing. See `preview.ts` for why there is no image renderer here.
 */

import type { ReactNode } from "react";
import { useOptionalCodeFlow } from "../context/hooks.js";
import { cn } from "../ui/cn.js";
import { pickPreviewRenderer, previewText, type PreviewContext } from "./preview.js";

export interface PreviewValueProps extends PreviewContext {
  className?: string;
  /** Height cap for the built-in renderer; a host renderer manages its own. */
  compact?: boolean;
}

export function PreviewValue(props: PreviewValueProps): ReactNode {
  const cf = useOptionalCodeFlow();
  const context: PreviewContext = {
    value: props.value,
    kind: props.kind,
    nodeId: props.nodeId,
    ...(props.schema === undefined ? {} : { schema: props.schema }),
    ...(props.mediaType === undefined ? {} : { mediaType: props.mediaType }),
  };

  const renderer = pickPreviewRenderer(cf?.previewRenderers, context);
  if (renderer !== null) {
    return (
      <div className={cn("min-w-0", props.className)} data-preview-renderer={renderer.id}>
        {renderer.render(context)}
      </div>
    );
  }

  return (
    <pre
      data-preview-renderer="builtin:json"
      className={cn(
        "cf-scroll m-0 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-2 p-2",
        "font-mono text-[10.5px] leading-4 text-ink-dim",
        props.compact === true ? "max-h-32" : "max-h-64",
        props.className,
      )}
    >
      {previewText(props.value)}
    </pre>
  );
}
