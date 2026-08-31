/**
 * The visual language of a node — 07 §3 and §5.
 *
 * Two rules:
 *
 * 1. **Type is read, not spelled.** Every node type owns an icon and a hue, so
 *    a trigger, a decision, a repeat and an unrecognised statement are told
 *    apart before a single word is read. The hue is a token (`--cf-<type>`),
 *    never a literal, so the whole palette moves with the theme.
 * 2. **Hosts still own their tools.** A registry entry may carry an `icon`
 *    (05 §2). A name from the icon set below resolves to that icon; anything
 *    else — an emoji, a single letter — is rendered verbatim, because the core
 *    is deliberately tool-agnostic (00 §6.6b) and this layer must not decide
 *    what a host's tool looks like.
 *
 * **Data only, no JSX.** The two components that consume this table live in
 * `glyphs.tsx`. React Fast Refresh can only take over a module whose every
 * export is a component; a module that mixes `nodeVisual`/`REGISTRY_ICONS` with
 * `<NodeGlyph>` is not a boundary, so every rebuild of it escalates to a full
 * page reload — which in this app throws away the conversation, the flow being
 * edited and any in-flight request. Same split, same reason, as
 * `context/provider.tsx` → `context.ts`/`hooks.ts`/`types.ts`.
 */

import type { LucideIcon } from "lucide-react";
import {
  Ban,
  Bell,
  Blocks,
  Bot,
  Braces,
  Calendar,
  CircleCheck,
  CircleDashed,
  CircleQuestionMark,
  Cloud,
  Code,
  CreditCard,
  Database,
  FileDiff,
  FileText,
  Files,
  Filter,
  Folder,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Globe,
  Hash,
  Key,
  Mail,
  MessageSquare,
  Package,
  Repeat,
  Rocket,
  Send,
  Settings2,
  Shield,
  ShieldCheck,
  ShoppingCart,
  Split,
  SquareFunction,
  Star,
  Terminal,
  Timer,
  Users,
  Waypoints,
  Webhook,
  Wrench,
  Zap,
} from "lucide-react";
import type { WorkflowNode } from "@codeflow-team/core";

/** Node types this UI knows how to draw. */
export type NodeVisualType =
  | "trigger"
  | "tool"
  | "function"
  | "condition"
  | "loop"
  | "try"
  | "parallel"
  | "merge"
  | "jump"
  | "output"
  | "code"
  | "unknown";

export interface NodeVisual {
  Icon: LucideIcon;
  /** CSS custom property holding this type's hue. */
  colorVar: string;
  /** Utility class that paints text in that hue (static, so Tailwind sees it). */
  textClass: string;
  /** Utility class for a soft tinted chip in that hue. */
  chipClass: string;
}

const VISUALS: Record<string, NodeVisual> = {
  trigger: { Icon: Zap, colorVar: "--cf-trigger", textClass: "text-node-trigger", chipClass: "bg-node-trigger/12 text-node-trigger" },
  tool: { Icon: Wrench, colorVar: "--cf-tool", textClass: "text-node-tool", chipClass: "bg-node-tool/12 text-node-tool" },
  function: { Icon: SquareFunction, colorVar: "--cf-function", textClass: "text-node-function", chipClass: "bg-node-function/12 text-node-function" },
  condition: { Icon: Split, colorVar: "--cf-condition", textClass: "text-node-condition", chipClass: "bg-node-condition/12 text-node-condition" },
  loop: { Icon: Repeat, colorVar: "--cf-loop", textClass: "text-node-loop", chipClass: "bg-node-loop/12 text-node-loop" },
  try: { Icon: Shield, colorVar: "--cf-try", textClass: "text-node-try", chipClass: "bg-node-try/12 text-node-try" },
  parallel: { Icon: Waypoints, colorVar: "--cf-parallel", textClass: "text-node-parallel", chipClass: "bg-node-parallel/12 text-node-parallel" },
  merge: { Icon: GitMerge, colorVar: "--cf-merge", textClass: "text-node-merge", chipClass: "bg-node-merge/12 text-node-merge" },
  jump: { Icon: Ban, colorVar: "--cf-jump", textClass: "text-node-jump", chipClass: "bg-node-jump/12 text-node-jump" },
  output: { Icon: CircleCheck, colorVar: "--cf-output", textClass: "text-node-output", chipClass: "bg-node-output/12 text-node-output" },
  code: { Icon: Code, colorVar: "--cf-code", textClass: "text-node-code", chipClass: "bg-node-code/12 text-node-code" },
  unknown: { Icon: CircleQuestionMark, colorVar: "--cf-unknown", textClass: "text-node-unknown", chipClass: "bg-node-unknown/12 text-node-unknown" },
};

const FALLBACK: NodeVisual = {
  Icon: CircleDashed,
  colorVar: "--cf-merge",
  textClass: "text-node-merge",
  chipClass: "bg-node-merge/12 text-node-merge",
};

export function nodeVisual(node: WorkflowNode): NodeVisual {
  return VISUALS[node.type] ?? FALLBACK;
}

/**
 * The icon set a registry entry can name in its `icon` field.
 *
 * A curated list rather than the whole of lucide: a bundler can then drop what
 * a host does not use, and the names stay a documented contract instead of an
 * implementation detail of whichever icon package is installed.
 */
export const REGISTRY_ICONS: Record<string, LucideIcon> = {
  bell: Bell,
  blocks: Blocks,
  bot: Bot,
  braces: Braces,
  calendar: Calendar,
  cloud: Cloud,
  code: Code,
  "credit-card": CreditCard,
  database: Database,
  "file-diff": FileDiff,
  "file-text": FileText,
  files: Files,
  filter: Filter,
  folder: Folder,
  "git-branch": GitBranch,
  "git-merge": GitMerge,
  "git-pull-request": GitPullRequest,
  globe: Globe,
  hash: Hash,
  key: Key,
  mail: Mail,
  "message-square": MessageSquare,
  package: Package,
  repeat: Repeat,
  rocket: Rocket,
  send: Send,
  settings: Settings2,
  shield: Shield,
  "shield-check": ShieldCheck,
  "shopping-cart": ShoppingCart,
  star: Star,
  terminal: Terminal,
  timer: Timer,
  users: Users,
  webhook: Webhook,
  wrench: Wrench,
  zap: Zap,
};
