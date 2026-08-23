/**
 * `<ExampleGallery>` — the way into the example set.
 *
 * A dropdown could name four flows; it could not tell you what any of them is
 * for. The gallery answers the question the demo actually has to answer — *what
 * does this one show off?* — so every card carries the flow's summary, its real
 * size (lines, steps, containers, problems, all measured by analyzing it), and a
 * row of highlight chips naming the hard cases inside.
 *
 * Same command-palette mechanics as `<NodePalette>`: type to filter, arrows to
 * move, Enter to open, Esc to close.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Badge, Kbd, Modal, cn } from "@codeflow/react";
import {
  BookOpen,
  Boxes,
  CircleAlert,
  GitBranch,
  Gauge,
  LayoutGrid,
  Search,
  TriangleAlert,
} from "lucide-react";
import type { FlowExample } from "./examples-source.js";
import { EXAMPLES } from "./examples-source.js";
import { measureAll, statsFor, type ExampleStats } from "./example-stats.js";

type Category = FlowExample["category"];

interface CategoryMeta {
  id: Category;
  label: string;
  hint: string;
  icon: typeof BookOpen;
}

const CATEGORIES: CategoryMeta[] = [
  { id: "basics", label: "Basics", hint: "Start here — the shapes every flow is made of", icon: BookOpen },
  { id: "control-flow", label: "Control flow", hint: "Loops, branches, jumps and parallel work", icon: GitBranch },
  { id: "real-mcp", label: "Real MCP tools", hint: "Production-sized flows over real tool surfaces", icon: Boxes },
  { id: "stress", label: "Stress", hint: "Deep nesting and long graphs, on purpose", icon: Gauge },
  { id: "degradation", label: "Degradation", hint: "What a flow looks like when it is not fully understood", icon: TriangleAlert },
];

export interface ExampleGalleryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentId: string;
  onPick: (example: FlowExample) => void;
  trigger?: ReactElement | null;
}

export function ExampleGallery(props: ExampleGalleryProps): ReactNode {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Category | "all">("all");
  const [active, setActive] = useState(0);
  const [, setTick] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Numbers are measured on first open and cached; the tick just re-renders the
  // cards as each one lands.
  useEffect(() => {
    if (!props.open) return;
    let alive = true;
    void measureAll(EXAMPLES, () => {
      if (alive) setTick((value) => value + 1);
    });
    return () => { alive = false; };
  }, [props.open]);

  useEffect(() => {
    if (props.open) { setQuery(""); setFilter("all"); }
  }, [props.open]);

  /**
   * Every word has to appear somewhere in the card, but not next to each other:
   * the highlights are prose with backticked code in the middle of them, so
   * "labelled break" has to find "labelled `break outer`" or the search is
   * lying about what is in the set.
   */
  const matches = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter((term) => term.length > 0);
    return EXAMPLES.filter((example) => {
      if (filter !== "all" && example.category !== filter) return false;
      if (terms.length === 0) return true;
      const haystack = [
        example.title,
        example.summary,
        example.description,
        example.registryId,
        ...example.highlights,
      ]
        .join(" ")
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [query, filter]);

  const groups = useMemo(
    () =>
      CATEGORIES.map((category) => ({
        ...category,
        entries: matches.filter((example) => example.category === category.id),
      })).filter((group) => group.entries.length > 0),
    [matches],
  );

  const flat = useMemo(() => groups.flatMap((group) => group.entries), [groups]);

  useEffect(() => { setActive(0); }, [query, filter, props.open]);

  useEffect(() => {
    const element = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    element?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (example: FlowExample): void => {
    props.onPick(example);
    props.onOpenChange(false);
  };

  const counts = useMemo(() => {
    const out = new Map<Category | "all", number>([["all", EXAMPLES.length]]);
    for (const example of EXAMPLES) out.set(example.category, (out.get(example.category) ?? 0) + 1);
    return out;
  }, []);

  return (
    <>
      {props.trigger === null || props.trigger === undefined ? null : (
        <span
          className="inline-flex"
          data-testid="gallery-trigger"
          onClick={() => { props.onOpenChange(true); }}
        >
          {props.trigger}
        </span>
      )}

      <Modal
        open={props.open}
        onOpenChange={props.onOpenChange}
        title="Example flows"
        description="Each one is a real file — the diagram next to it is read straight from the code."
        className="max-h-[min(46rem,calc(100dvh-3rem))] w-[min(64rem,calc(100vw-2rem))]"
      >
        <div className="flex min-h-0 flex-1 flex-col" data-testid="gallery">
          <div className="relative border-b border-line">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
            <input
              autoFocus
              type="text"
              id="cf-gallery-search"
              name="gallery-search"
              aria-label="Search example flows"
              data-testid="gallery-search"
              placeholder="Search flows, or what they show off — “parallel”, “try”, “unknown tool”…"
              value={query}
              onChange={(event) => { setQuery(event.target.value); }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActive((current) => (flat.length === 0 ? 0 : (current + 1) % flat.length));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive((current) => (flat.length === 0 ? 0 : (current - 1 + flat.length) % flat.length));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const example = flat[active];
                  if (example !== undefined) pick(example);
                }
              }}
              className="h-12 w-full appearance-none border-0 bg-transparent pl-11 pr-4 font-sans text-[14px] text-ink outline-none placeholder:text-ink-faint"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
            <FilterChip
              active={filter === "all"}
              icon={LayoutGrid}
              label="Everything"
              count={counts.get("all") ?? 0}
              onClick={() => { setFilter("all"); }}
            />
            {CATEGORIES.map((category) => (
              <FilterChip
                key={category.id}
                active={filter === category.id}
                icon={category.icon}
                label={category.label}
                count={counts.get(category.id) ?? 0}
                onClick={() => { setFilter(category.id); }}
              />
            ))}
          </div>

          <div ref={listRef} className="cf-scroll min-h-0 flex-1 overflow-y-auto p-3">
            {flat.length === 0 ? (
              <p className="m-0 px-2 py-10 text-center text-[12.5px] text-ink-dim">
                Nothing matches “{query.trim()}”.
              </p>
            ) : (
              groups.map((group) => (
                <section key={group.id} className="mb-4 last:mb-0">
                  <header className="flex items-baseline gap-2 px-1 pb-2">
                    <group.icon className="size-3.5 shrink-0 translate-y-0.5 text-ink-faint" />
                    <h3 className="m-0 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
                      {group.label}
                    </h3>
                    <span className="truncate text-[11.5px] text-ink-faint/85">{group.hint}</span>
                  </header>
                  <div className="grid gap-2 lg:grid-cols-2">
                    {group.entries.map((example) => (
                      <ExampleCard
                        key={example.id}
                        example={example}
                        stats={statsFor(example.id)}
                        current={example.id === props.currentId}
                        active={flat.indexOf(example) === active}
                        onHover={() => { setActive(flat.indexOf(example)); }}
                        onPick={() => { pick(example); }}
                      />
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>

          <div className="flex items-center gap-3 border-t border-line bg-surface-2 px-4 py-2 text-[11px] text-ink-faint">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              to move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd>
              to open
            </span>
            <span className="ml-auto flex items-center gap-1">
              <Kbd>esc</Kbd>
              to close
            </span>
          </div>
        </div>
      </Modal>
    </>
  );
}

function FilterChip(props: {
  active: boolean;
  icon: typeof BookOpen;
  label: string;
  count: number;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      className={cn(
        "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-medium transition-colors",
        props.active
          ? "border-transparent bg-accent text-accent-fg"
          : "border-line bg-surface text-ink-dim hover:bg-surface-2",
      )}
    >
      <props.icon className="size-3.5" />
      {props.label}
      <span className={cn("text-[10.5px]", props.active ? "text-accent-fg/70" : "text-ink-faint")}>
        {props.count}
      </span>
    </button>
  );
}

function ExampleCard(props: {
  example: FlowExample;
  stats: ExampleStats | null;
  current: boolean;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}): ReactNode {
  const { example, stats } = props;
  const problems = stats === null ? 0 : stats.errors + stats.warnings;

  return (
    <button
      type="button"
      data-testid={`gallery-card-${example.id}`}
      data-active={props.active ? "true" : "false"}
      onMouseMove={props.onHover}
      onClick={props.onPick}
      className={cn(
        "flex cursor-pointer flex-col gap-2 rounded-xl border p-3 text-left transition-colors",
        props.active ? "border-line-strong bg-surface-2" : "border-line bg-surface hover:bg-surface-2/60",
        props.current ? "ring-1 ring-accent" : "",
      )}
    >
      <div className="flex items-start gap-2">
        <h4 className="m-0 min-w-0 flex-1 text-[13.5px] font-semibold leading-snug tracking-[-0.01em] text-ink">
          {example.title}
        </h4>
        {props.current ? <Badge tone="accent">open</Badge> : null}
      </div>

      <p className="m-0 line-clamp-2 text-[12px] leading-relaxed text-ink-dim">{example.summary}</p>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral" title="Lines in the flow file">
          {example.lines} lines
        </Badge>
        <Badge tone="neutral" title="Nodes the analyzer produced, minus the synthetic ends">
          {stats === null ? "· steps" : `${stats.steps} steps`}
        </Badge>
        {stats !== null && stats.containers > 0 ? (
          <Badge tone="neutral" title="Loops and try blocks that hold other steps">
            {stats.containers} containers
          </Badge>
        ) : null}
        {problems > 0 ? (
          <Badge tone={stats !== null && stats.errors > 0 ? "danger" : "warn"} title="Diagnostics on this flow">
            <CircleAlert />
            {problems}
          </Badge>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1">
        {example.highlights.slice(0, 4).map((highlight) => (
          <span
            key={highlight}
            className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[10.5px] leading-[1.5] text-ink-dim"
          >
            {highlight}
          </span>
        ))}
        {example.highlights.length > 4 ? (
          <span className="px-1 py-0.5 text-[10.5px] leading-[1.5] text-ink-faint">
            +{example.highlights.length - 4} more
          </span>
        ) : null}
      </div>
    </button>
  );
}
