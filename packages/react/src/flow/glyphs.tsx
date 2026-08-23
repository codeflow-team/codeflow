/**
 * The two glyph components — 07 §3.
 *
 * Nothing but components lives here on purpose. React Fast Refresh replaces a
 * module in place only when *every* export of it is a component; the moment a
 * plain function or a lookup table shares the file, the module stops being a
 * refresh boundary and Vite escalates the update to `full-reload`. In this app a
 * full reload costs the whole chat conversation, the flow currently being edited
 * and any AI request in flight, so the table (`nodeVisual`, `REGISTRY_ICONS`)
 * stays in `visual.ts` and the components stay here.
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { WorkflowNode } from "@codeflow/core";
import { stringData } from "../graph/index.js";
import { nodeVisual, REGISTRY_ICONS } from "./visual.js";

/**
 * The glyph for a node: the registry's icon when it names one this build knows,
 * a host-supplied glyph verbatim when it does not, and the node type's own icon
 * when the registry says nothing.
 */
export function NodeGlyph({ node, className }: { node: WorkflowNode; className?: string }): ReactNode {
  const registryIcon = stringData(node, "icon");
  if (registryIcon !== null && registryIcon.length > 0) {
    const Named = REGISTRY_ICONS[registryIcon];
    if (Named !== undefined) return <Named className={className} aria-hidden="true" />;
    return (
      <span className="text-[13px] leading-none" aria-hidden="true">
        {registryIcon}
      </span>
    );
  }
  const { Icon } = nodeVisual(node);
  return <Icon className={className} aria-hidden="true" />;
}

/** Same resolution, for a registry entry that is not (yet) a node. */
export function RegistryGlyph({
  icon,
  fallback,
  className,
}: {
  icon: string | undefined;
  fallback: LucideIcon;
  className?: string;
}): ReactNode {
  if (icon !== undefined && icon.length > 0) {
    const Named = REGISTRY_ICONS[icon];
    if (Named !== undefined) return <Named className={className} aria-hidden="true" />;
    return (
      <span className="text-[13px] leading-none" aria-hidden="true">
        {icon}
      </span>
    );
  }
  const Icon = fallback;
  return <Icon className={className} aria-hidden="true" />;
}
