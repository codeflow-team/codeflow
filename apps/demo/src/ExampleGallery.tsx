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
import type { RegistryLookup } from "@codeflow-team/core";
import { Badge, Button, Input, Kbd, Modal, Notice, cn } from "@codeflow-team/react";
import {
  BookOpen,
  Boxes,
  CircleAlert,
  Download,
  GitBranch,
  Gauge,
  LayoutGrid,
  Pencil,
  Plus,
  Search,
  Trash2,
  TriangleAlert,
  User,
} from "lucide-react";
import type { FlowExample } from "./examples-source.js";
import { EXAMPLES } from "./examples-source.js";
import { measureAll, statsFor, type ExampleStats } from "./example-stats.js";
import { asExample, registryLabelFor, type MyFlow } from "./my-flows.js";

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
  /**
   * The visitor's own flows — first-class, and listed above the examples.
   *
   * They are theirs, so they can be renamed, deleted and exported from here;
   * the built-in set below them cannot, which is the whole reason the gallery
   * stays trustworthy after somebody starts editing.
   */
  mine?: readonly MyFlow[];
  onNew?: () => void;
  onRename?: (id: string, title: string) => void;
  onDelete?: (id: string) => void;
  onExport?: (flow: MyFlow) => void;
  /** The registry a flow's card should be measured against, when it is not the example's own. */
  lookupFor?: (example: FlowExample) => RegistryLookup | undefined;
  /** Set when the browser refused to keep the list, so the gallery can say so. */
  storageError?: string | null;
}

export function ExampleGallery(props: ExampleGalleryProps): ReactNode {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Category | "all" | "mine">("all");
  const [active, setActive] = useState(0);
  const [, setTick] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const mineExamples = useMemo(
    () => (props.mine ?? []).map((flow) => asExample(flow)),
    [props.mine],
  );

  // Numbers are measured on first open and cached; the tick just re-renders the
  // cards as each one lands. The visitor's own flows go first — they are the
  // ones whose numbers have never been seen before.
  const lookupFor = props.lookupFor;
  useEffect(() => {
    if (!props.open) return;
    let alive = true;
    void measureAll(
      [...mineExamples, ...EXAMPLES],
      () => { if (alive) setTick((value) => value + 1); },
      lookupFor,
    );
    return () => { alive = false; };
  }, [props.open, mineExamples, lookupFor]);

  useEffect(() => {
    if (props.open) return;
    setRenaming(null);
    setConfirming(null);
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
  const terms = useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter((term) => term.length > 0),
    [query],
  );

  const matches = useMemo(() => {
    if (filter === "mine") return [];
    return EXAMPLES.filter((example) => {
      if (filter !== "all" && example.category !== filter) return false;
      return hits(example, terms);
    });
  }, [terms, filter]);

  /** The visitor's own, filtered by words only — the chips below are categories. */
  const mineMatches = useMemo(() => {
    if (filter !== "all" && filter !== "mine") return [];
    return mineExamples.filter((example) => hits(example, terms));
  }, [mineExamples, terms, filter]);

  const groups = useMemo(
    () =>
      CATEGORIES.map((category) => ({
        ...category,
        entries: matches.filter((example) => example.category === category.id),
      })).filter((group) => group.entries.length > 0),
    [matches],
  );

  const flat = useMemo(
    () => [...mineMatches, ...groups.flatMap((group) => group.entries)],
    [mineMatches, groups],
  );

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
    const out = new Map<Category | "all" | "mine", number>([
      ["all", EXAMPLES.length + mineExamples.length],
      ["mine", mineExamples.length],
    ]);
    for (const example of EXAMPLES) out.set(example.category, (out.get(example.category) ?? 0) + 1);
    return out;
  }, [mineExamples.length]);

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
        title="Flows"
        description="Yours at the top, the built-in examples below. Every one is a real file — the diagram next to it is read straight from the code."
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
            {mineExamples.length === 0 ? null : (
              <FilterChip
                active={filter === "mine"}
                icon={User}
                label="My flows"
                count={counts.get("mine") ?? 0}
                onClick={() => { setFilter("mine"); }}
              />
            )}
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

          {props.storageError == null ? null : (
            <div className="border-b border-line px-3 py-2">
              <Notice tone="warn" title="Your flows are not being saved" data-testid="gallery-storage-error">
                {props.storageError}
              </Notice>
            </div>
          )}

          <div ref={listRef} className="cf-scroll min-h-0 flex-1 overflow-y-auto p-3">
            {/* ------------------------------------------------------------ */}
            {/* yours — first, because a gallery you cannot add to is a museum */}
            {/* ------------------------------------------------------------ */}
            {filter === "all" || filter === "mine" ? (
              <section className="mb-4">
                <header className="flex items-baseline gap-2 px-1 pb-2">
                  <User className="size-3.5 shrink-0 translate-y-0.5 text-ink-faint" />
                  <h3 className="m-0 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
                    My flows
                  </h3>
                  <span className="truncate text-[11.5px] text-ink-faint/85">
                    {mineExamples.length === 0
                      ? "Nothing here yet — start one and it lives in this browser"
                      : "Saved in this browser · rename, export or delete them here"}
                  </span>
                </header>
                <div className="grid gap-2 lg:grid-cols-2">
                  {props.onNew === undefined ? null : (
                    <button
                      type="button"
                      data-testid="gallery-new-flow"
                      onClick={() => { props.onNew?.(); props.onOpenChange(false); }}
                      className="flex min-h-[6.5rem] cursor-pointer flex-col justify-center gap-1 rounded-xl border border-dashed border-line-strong bg-surface-2/40 p-3 text-left transition-colors hover:border-accent hover:bg-accent-soft/40"
                    >
                      <span className="flex items-center gap-1.5 text-[13.5px] font-semibold text-ink">
                        <Plus className="size-4 text-accent" />
                        New flow
                        <span className="ml-1 rounded bg-surface-3 px-1 py-0.5 text-[10px] font-normal leading-none text-ink-faint">
                          ⌥⌘N
                        </span>
                      </span>
                      <span className="text-[12px] leading-relaxed text-ink-dim">
                        Describe what you want and the AI writes the file — or start from an empty
                        one and add the steps yourself.
                      </span>
                    </button>
                  )}
                  {mineMatches.map((example) => (
                    <MyFlowCard
                      key={example.id}
                      example={example}
                      stats={statsFor(example.id)}
                      current={example.id === props.currentId}
                      active={flat.indexOf(example) === active}
                      renaming={renaming === example.id}
                      confirming={confirming === example.id}
                      onHover={() => { setActive(flat.indexOf(example)); }}
                      onPick={() => { pick(example); }}
                      onStartRename={() => { setRenaming(example.id); setConfirming(null); }}
                      onRename={(title) => {
                        props.onRename?.(example.id, title);
                        setRenaming(null);
                      }}
                      onCancelRename={() => { setRenaming(null); }}
                      onAskDelete={() => { setConfirming(example.id); setRenaming(null); }}
                      onCancelDelete={() => { setConfirming(null); }}
                      onDelete={() => { props.onDelete?.(example.id); setConfirming(null); }}
                      onExport={() => { props.onExport?.(example.mine); }}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {flat.length === 0 && mineExamples.length === 0 && terms.length > 0 ? (
              <p className="m-0 px-2 py-10 text-center text-[12.5px] text-ink-dim">
                Nothing matches “{query.trim()}”.
              </p>
            ) : matches.length === 0 && terms.length > 0 && filter !== "mine" ? (
              <p className="m-0 px-2 py-10 text-center text-[12.5px] text-ink-dim">
                No example matches “{query.trim()}”.
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

/**
 * Every word has to appear somewhere in the card, but not next to each other:
 * the highlights are prose with backticked code in the middle of them, so
 * "labelled break" has to find "labelled `break outer`" or the search is lying
 * about what is in the set.
 */
function hits(example: FlowExample, terms: readonly string[]): boolean {
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
}

/**
 * One of the visitor's own flows.
 *
 * Deliberately not `<ExampleCard>` with buttons bolted on: a card that can be
 * renamed and deleted cannot be a single `<button>` (nested buttons are invalid
 * and unreachable by keyboard), so the body is a `div` with an explicit `Open`
 * affordance and the three verbs sit beside it.
 */
function MyFlowCard(props: {
  example: FlowExample & { mine: MyFlow };
  stats: ExampleStats | null;
  current: boolean;
  active: boolean;
  renaming: boolean;
  confirming: boolean;
  onHover: () => void;
  onPick: () => void;
  onStartRename: () => void;
  onRename: (title: string) => void;
  onCancelRename: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
  onExport: () => void;
}): ReactNode {
  const { example, stats } = props;
  const [draft, setDraft] = useState(example.title);
  const problems = stats === null ? 0 : stats.errors + stats.warnings;
  const generation = example.mine.generation;

  useEffect(() => { setDraft(example.title); }, [example.title, props.renaming]);

  return (
    <div
      data-testid={`gallery-card-${example.id}`}
      data-active={props.active ? "true" : "false"}
      onMouseMove={props.onHover}
      className={cn(
        "flex flex-col gap-2 rounded-xl border p-3 text-left transition-colors",
        props.active ? "border-line-strong bg-surface-2" : "border-line bg-surface",
        props.current ? "ring-1 ring-accent" : "",
      )}
    >
      {props.renaming ? (
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const next = draft.trim();
            if (next.length > 0) props.onRename(next);
            else props.onCancelRename();
          }}
        >
          <Input
            autoFocus
            value={draft}
            aria-label={`Rename ${example.title}`}
            data-testid="gallery-rename-input"
            className="min-w-0 flex-1"
            onChange={(event) => { setDraft(event.target.value); }}
            onKeyDown={(event) => { if (event.key === "Escape") props.onCancelRename(); }}
          />
          <Button type="submit" variant="primary" size="sm" data-testid="gallery-rename-save">
            Rename
          </Button>
          <Button variant="ghost" size="sm" onClick={props.onCancelRename}>
            Cancel
          </Button>
        </form>
      ) : (
        <button
          type="button"
          onClick={props.onPick}
          data-testid={`gallery-open-${example.id}`}
          className="flex cursor-pointer items-start gap-2 bg-transparent p-0 text-left"
        >
          <h4 className="m-0 min-w-0 flex-1 text-[13.5px] font-semibold leading-snug tracking-[-0.01em] text-ink">
            {example.title}
          </h4>
          {props.current ? <Badge tone="accent">open</Badge> : null}
        </button>
      )}

      <p className="m-0 line-clamp-2 text-[12px] leading-relaxed text-ink-dim">{example.summary}</p>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral" title="The registry this flow was written against">
          {registryLabelFor(example.mine.registryChoice).slice(0, 34)}
        </Badge>
        <Badge tone="neutral">{example.lines} lines</Badge>
        <Badge tone="neutral" title="Nodes the analyzer produced, minus the synthetic ends">
          {stats === null ? "· steps" : `${stats.steps} steps`}
        </Badge>
        {generation === null ? null : (
          <Badge
            tone={generation.level === "L1" || generation.level === "L2" ? "ok" : "warn"}
            title={generation.unresolved ?? "Conformance level the generation loop reached (10 §5)"}
          >
            {generation.level} · {generation.rounds} round{generation.rounds === 1 ? "" : "s"}
          </Badge>
        )}
        {problems > 0 ? (
          <Badge tone={stats !== null && stats.errors > 0 ? "danger" : "warn"} title="Diagnostics on this flow">
            <CircleAlert />
            {problems}
          </Badge>
        ) : null}
      </div>

      {props.confirming ? (
        <div className="flex items-center gap-2 rounded-lg border border-danger/40 bg-danger-soft px-2.5 py-1.5">
          <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-danger">
            Delete “{example.title}”? It is only in this browser, so there is no other copy.
          </span>
          <Button variant="danger" size="xs" data-testid="gallery-delete-confirm" onClick={props.onDelete}>
            Delete
          </Button>
          <Button variant="ghost" size="xs" onClick={props.onCancelDelete}>
            Keep
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <Button variant="secondary" size="xs" data-testid="gallery-open-button" onClick={props.onPick}>
            Open
          </Button>
          <Button variant="ghost" size="xs" data-testid="gallery-rename" onClick={props.onStartRename}>
            <Pencil />
            Rename
          </Button>
          <Button variant="ghost" size="xs" data-testid="gallery-export" onClick={props.onExport}>
            <Download />
            Export
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto"
            data-testid="gallery-delete"
            onClick={props.onAskDelete}
          >
            <Trash2 />
          </Button>
        </div>
      )}
    </div>
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
