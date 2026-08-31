/**
 * `<McpManager>` — bring your own MCP servers.
 *
 * The architectural claim of this project is that core knows no tool: everything
 * that can become a node arrives through the registry at runtime (00 §6.6b,
 * 05 §3). Five registries baked into `@codeflow-team/examples` demonstrate that
 * badly, because they were put there by us. This panel is the honest version —
 * point it at *your* MCP server and your tools become palette entries, lines in
 * `tools.d.ts` for the AI, nodes in the graph, and bindings when you press Run.
 * No core change, no analyzer change, nothing hard-coded anywhere.
 *
 * Four things on screen are load-bearing rather than decorative:
 *
 *  - **the per-tool checkboxes.** A 100-tool server does not belong in an AI
 *    prompt (10 §4), and the token counter next to the list moves as you pick,
 *    so the cost of "select all" is a number rather than a surprise.
 *  - **the namespace field.** `tools.<ns>.<method>` is what the flow code will
 *    literally say, so the namespace is a naming decision, not an internal id.
 *    Two servers claiming one namespace is refused out loud, never merged.
 *  - **the `tools.d.ts` tab.** One artifact, three consumers (05 §2). Being
 *    able to read the file the AI reads is half of what makes that concrete.
 *  - **the stdio warning.** Typing a command into a web page and having it run
 *    is remote code execution on this machine. It is said in those words, once,
 *    before the first one is added.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  buildGenerationContext,
  createRegistry,
  estimateTokens,
  generateToolsDts,
  type RegistryLookup,
} from "@codeflow-team/core";
import {
  Badge,
  Button,
  Field,
  FieldHint,
  FieldLabel,
  Hint,
  Input,
  Modal,
  Notice,
  Segmented,
  cn,
  useToast,
} from "@codeflow-team/react";
import {
  Check,
  Copy,
  Globe,
  LoaderCircle,
  Plug,
  Plus,
  RotateCcw,
  Search,
  ServerCog,
  Terminal,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { CATALOG, REMOTE_CATALOG, STDIO_CATALOG, type CatalogEntry } from "./mcp/catalog.js";
import { discoverServer, fetchMcpStatus, type McpServerStatus } from "./mcp/discover.js";
import {
  compose,
  defaultNamespace,
  formatCommand,
  includedTools,
  isSelected,
  newServerId,
  parseCommand,
  selectAll,
  statusOf,
  toggleTool,
  type McpServerConfig,
  type McpTransport,
} from "./mcp/model.js";
import { acknowledgeStdio, setSessionToken, stdioAcknowledged, tokenFor } from "./mcp/storage.js";
import type { McpServersState } from "./mcp/use-mcp-servers.js";

export interface McpManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: McpServersState;
  /** The registry actually in force right now — what `tools.d.ts` is shown for. */
  lookup: RegistryLookup;
  /** True when that registry is the composed one rather than an example's. */
  fromMcp: boolean;
  /** Name of the registry that is used when no server contributes anything. */
  fallbackLabel: string;
  trigger?: ReactElement | null;
}

type Tab = "servers" | "add" | "dts";

export function McpManager(props: McpManagerProps): ReactNode {
  const { state } = props;
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("servers");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<McpServerStatus>({ available: false, stdio: false, stdioReason: null });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [warnOpen, setWarnOpen] = useState(false);
  const pendingStdio = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!props.open) return;
    void fetchMcpStatus().then(setStatus);
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    if (state.servers.length === 0) setTab("add");
    else if (selectedId === null || !state.servers.some((server) => server.id === selectedId)) {
      setSelectedId(state.servers[0]?.id ?? null);
    }
  }, [props.open, state.servers, selectedId]);

  const selected = state.servers.find((server) => server.id === selectedId) ?? null;

  /**
   * Ask before the first `spawn`.
   *
   * Not a toast and not a tooltip: this is the one action in the demo that runs
   * a program on the reader's machine, and 07 §5's rule about saying what a
   * control really does is at its sharpest here. Acknowledged once, then
   * remembered — nagging every time trains people to click through.
   */
  const guardStdio = (action: () => void): void => {
    if (stdioAcknowledged()) {
      action();
      return;
    }
    pendingStdio.current = action;
    setWarnOpen(true);
  };

  const runDiscovery = async (config: McpServerConfig): Promise<void> => {
    setBusyId(config.id);
    try {
      const token = tokenFor(config);
      const headers =
        config.headerName !== undefined && config.headerName.length > 0 && token !== undefined && token.length > 0
          ? { [config.headerName]: token }
          : undefined;
      const outcome = await discoverServer({
        transport: config.transport,
        namespace: config.namespace,
        name: config.name,
        ...(config.command === undefined ? {} : { command: config.command }),
        ...(config.args === undefined ? {} : { args: config.args }),
        ...(config.url === undefined ? {} : { url: config.url }),
        ...(headers === undefined ? {} : { headers }),
      });

      if (!outcome.ok) {
        state.updateServer(config.id, {
          discovery: null,
          error: outcome.hint === undefined ? outcome.error : `${outcome.error}\n\n${outcome.hint}`,
        });
        return;
      }

      // Tools that vanished between two discoveries must not stay selected —
      // a selection naming a tool that no longer exists would quietly compose
      // to a smaller registry than the list on screen claims.
      const names = new Set(outcome.discovery.tools.map((tool) => tool.method));
      const selection =
        config.selected === null ? null : config.selected.filter((method) => names.has(method));

      state.updateServer(config.id, {
        discovery: outcome.discovery,
        error: null,
        enabled: true,
        selected: selection,
      });
      setSelectedId(config.id);
      setTab("servers");
      toast.add({
        title: `${config.name} connected`,
        description: `${String(outcome.discovery.tools.length)} tool${outcome.discovery.tools.length === 1 ? "" : "s"} discovered over ${outcome.discovery.transport}.`,
      });
    } finally {
      setBusyId(null);
    }
  };

  /**
   * `onCommitted` runs only once the server is really being added.
   *
   * A stdio add can sit behind the warning modal for as long as it takes to
   * read it, and the reader is allowed to say no. Clearing the form at the
   * moment of the *click* threw away a command they had just typed the instant
   * they pressed Cancel — the one outcome the warning exists to make easy.
   */
  const addAndDiscover = (config: McpServerConfig, onCommitted?: () => void): void => {
    const start = (): void => {
      onCommitted?.();
      state.addServer(config);
      setSelectedId(config.id);
      void runDiscovery(config);
    };
    if (config.transport === "stdio") guardStdio(start);
    else start();
  };

  const collisionFor = (config: McpServerConfig): string | null => {
    const clash = state.composed.collisions.find((entry) => entry.serverIds.includes(config.id));
    if (clash === undefined) return null;
    if (clash.serverIds[0] === config.id) return null;
    const owner = state.servers.find((server) => server.id === clash.serverIds[0]);
    return `“${owner?.name ?? "another server"}” already uses \`${clash.namespace}\`, so none of these tools are in the registry. Give this one a different namespace.`;
  };

  return (
    <>
      {props.trigger === undefined || props.trigger === null ? null : (
        <span onClick={() => { props.onOpenChange(true); }}>{props.trigger}</span>
      )}

      <Modal
        open={props.open}
        onOpenChange={props.onOpenChange}
        title="MCP servers"
        description="Point the demo at your own servers. Their tools become palette entries, the AI's tools.d.ts, nodes in the graph and bindings when you press Run."
        className="w-[min(76rem,calc(100vw-2rem))] max-h-[min(48rem,calc(100dvh-3rem))]"
        action={
          <Segmented<Tab>
            aria-label="MCP manager section"
            value={tab}
            onValueChange={setTab}
            items={[
              { value: "servers", label: `Servers${state.servers.length === 0 ? "" : ` (${String(state.servers.length)})`}` },
              { value: "add", label: "Add" },
              { value: "dts", label: "tools.d.ts" },
            ]}
          />
        }
        footer={
          <div className="flex w-full flex-wrap items-center gap-3">
            <RegistrySummary state={state} lookup={props.lookup} fromMcp={props.fromMcp} fallbackLabel={props.fallbackLabel} />
            <div className="ml-auto flex items-center gap-2">
              {state.servers.length === 0 ? null : (
                <Button
                  variant="ghost"
                  size="md"
                  data-testid="mcp-reset"
                  onClick={() => {
                    state.reset();
                    setSelectedId(null);
                    setTab("add");
                    toast.add({
                      title: "Back to the built-in examples",
                      description: "Every configured server was removed and the gallery's own registries are in force again.",
                    });
                  }}
                >
                  <RotateCcw />
                  Reset to the built-in examples
                </Button>
              )}
              <Button variant="secondary" size="md" onClick={() => { props.onOpenChange(false); }}>
                Done
              </Button>
            </div>
          </div>
        }
      >
        {/* `Modal` renders its children flush — the padding is the host's, so
            that a panel can go edge to edge when it wants to. This one does
            not: it is a settings surface and needs room to breathe. */}
        <div className="cf-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          {state.storageError === null ? null : (
            <Notice tone="warn" title="This list is not being saved">{state.storageError}</Notice>
          )}

          {tab === "add" ? (
            <AddTab
              status={status}
              existing={state.servers}
              onAdd={addAndDiscover}
              busy={busyId !== null}
            />
          ) : tab === "dts" ? (
            <DtsTab lookup={props.lookup} fromMcp={props.fromMcp} fallbackLabel={props.fallbackLabel} />
          ) : (
            <ServersTab
              state={state}
              selected={selected}
              onSelect={setSelectedId}
              busyId={busyId}
              onDiscover={(config) => {
                if (config.transport === "stdio") guardStdio(() => { void runDiscovery(config); });
                else void runDiscovery(config);
              }}
              collisionFor={collisionFor}
              onAdd={() => { setTab("add"); }}
            />
          )}
        </div>
      </Modal>

      <Modal
        open={warnOpen}
        onOpenChange={setWarnOpen}
        title="This starts a program on your machine"
        description="Read this once; it will not be asked again."
        className="w-[min(34rem,calc(100vw-2rem))]"
        footer={
          <div className="flex w-full items-center gap-2">
            <Button
              variant="secondary"
              size="md"
              className="ml-auto"
              onClick={() => { pendingStdio.current = null; setWarnOpen(false); }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              data-testid="mcp-stdio-accept"
              onClick={() => {
                acknowledgeStdio();
                setWarnOpen(false);
                const action = pendingStdio.current;
                pendingStdio.current = null;
                action?.();
              }}
            >
              I understand — start it
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 px-5 py-4 text-[12.5px] leading-relaxed text-ink-dim">
          <Notice tone="danger" title="A stdio server is a command, and the command runs here">
            The dev server behind this page will start the program you typed, as a child process, with
            your user account&rsquo;s permissions. It can read and write your files and reach your
            network. This is the same thing as pasting the command into your own terminal.
          </Notice>
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-4">
            <li>
              Nothing is sandboxed. The demo runner is a worker thread on a dev server, not an
              isolate (09 §1).
            </li>
            <li>
              Only ever add a command you would run yourself. <code className="font-mono text-[11.5px]">npx -y &lt;package&gt;</code>{" "}
              downloads and executes code from npm.
            </li>
            <li>
              There is no shell: the line is split on spaces and handed to <code className="font-mono text-[11.5px]">spawn</code>,
              so pipes, <code className="font-mono text-[11.5px]">&amp;&amp;</code> and variables are
              not interpreted. That limits accidents, not intent.
            </li>
            <li>
              This is refused entirely in the hosted build, and refused for requests that did not come
              from a browser on this machine.
            </li>
          </ul>
        </div>
      </Modal>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* footer summary                                                              */
/* -------------------------------------------------------------------------- */

function RegistrySummary(props: {
  state: McpServersState;
  lookup: RegistryLookup;
  fromMcp: boolean;
  fallbackLabel: string;
}): ReactNode {
  const tokens = useMemo(() => tokenCostOf(props.lookup), [props.lookup]);
  // Servers that actually put a tool in, not servers that are switched on: one
  // that lost a namespace collision, or that has every tool deselected, is
  // enabled and contributes nothing, and counting it would be a small lie.
  const contributing = props.state.composed.contributing.length;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-dim">
      <span className="inline-flex items-center gap-1.5 font-medium text-ink">
        <ServerCog className="size-3.5 text-accent" />
        {props.fromMcp ? "Your servers are the registry" : `Using ${props.fallbackLabel}`}
      </span>
      <span>
        {props.lookup.listTools().length} tool{props.lookup.listTools().length === 1 ? "" : "s"} ·{" "}
        {props.lookup.listToolNamespaces().length} namespace{props.lookup.listToolNamespaces().length === 1 ? "" : "s"}
        {props.fromMcp ? ` · from ${String(contributing)} server${contributing === 1 ? "" : "s"}` : ""}
      </span>
      <span title="Rough estimate at ~4 characters per token — enough to tell 'fits' from 'needs scoping' (10 §4).">
        tools.d.ts ≈ <strong className="font-semibold text-ink">{tokens.dts.toLocaleString()}</strong> tokens
      </span>
    </div>
  );
}

/** `tools.d.ts` on its own, and the whole prompt bundle around it. */
function tokenCostOf(lookup: RegistryLookup): { dts: number; context: number } {
  try {
    return {
      dts: estimateTokens(generateToolsDts(lookup)),
      context: buildGenerationContext(lookup).estimatedTokens,
    };
  } catch {
    // A registry that cannot be generated (a namespace colliding with a method
    // name) still has to render a panel; the number is what is missing, not the
    // page.
    return { dts: 0, context: 0 };
  }
}

/* -------------------------------------------------------------------------- */
/* servers tab                                                                 */
/* -------------------------------------------------------------------------- */

function ServersTab(props: {
  state: McpServersState;
  selected: McpServerConfig | null;
  onSelect: (id: string) => void;
  busyId: string | null;
  onDiscover: (config: McpServerConfig) => void;
  collisionFor: (config: McpServerConfig) => string | null;
  onAdd: () => void;
}): ReactNode {
  if (props.state.servers.length === 0) {
    return (
      <div className="grid place-items-center py-16 text-center">
        <div className="flex max-w-md flex-col items-center gap-3">
          <span className="grid size-11 place-items-center rounded-[12px] bg-surface-3 text-ink-faint">
            <Plug className="size-5" />
          </span>
          <p className="m-0 text-[13px] font-semibold text-ink">No servers yet</p>
          <p className="m-0 text-[12.5px] leading-relaxed text-ink-dim">
            The gallery is running on its built-in example registries. Add an MCP server and its tools
            take over the palette, the AI&rsquo;s context and the Run bindings.
          </p>
          <Button variant="primary" size="md" onClick={props.onAdd}>
            <Plus />
            Add a server
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[26rem] gap-6">
      <div className="flex w-[19rem] shrink-0 flex-col gap-2">
        <div className="flex items-center justify-between px-0.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Configured</span>
          <Button variant="ghost" size="icon-sm" aria-label="Add a server" onClick={props.onAdd}>
            <Plus />
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          {props.state.servers.map((server) => (
            <ServerRow
              key={server.id}
              config={server}
              active={props.selected?.id === server.id}
              busy={props.busyId === server.id}
              collision={props.collisionFor(server) !== null}
              onSelect={() => { props.onSelect(server.id); }}
              onToggle={() => { props.state.updateServer(server.id, { enabled: !server.enabled }); }}
            />
          ))}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        {props.selected === null ? null : (
          <ServerDetail
            key={props.selected.id}
            config={props.selected}
            state={props.state}
            busy={props.busyId === props.selected.id}
            collision={props.collisionFor(props.selected)}
            onDiscover={() => { props.onDiscover(props.selected as McpServerConfig); }}
          />
        )}
      </div>
    </div>
  );
}

function StatusDot({ config }: { config: McpServerConfig }): ReactNode {
  const status = statusOf(config);
  const tone =
    status === "connected" ? "bg-ok" : status === "failed" ? "bg-danger" : "bg-ink-faint";
  const label =
    status === "connected" ? "connected" : status === "failed" ? "failed" : "not connected";
  // `title`, not `<Hint>`: this dot is rendered inside a button, and a tooltip
  // trigger is itself focusable — one interactive element inside another.
  return <span className={cn("size-2 shrink-0 rounded-full", tone)} title={label} aria-label={label} role="img" />;
}

function Switch(props: { checked: boolean; onChange: () => void; label: string; disabled?: boolean }): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled === true}
      onClick={(event) => { event.stopPropagation(); props.onChange(); }}
      className={cn(
        "relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-150",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
        "disabled:cursor-not-allowed disabled:opacity-50",
        props.checked ? "border-accent bg-accent" : "border-line-strong bg-surface-3",
      )}
    >
      <span
        className={cn(
          "absolute size-3 rounded-full bg-surface shadow-xs transition-[left] duration-150",
          props.checked ? "left-[16px]" : "left-[2px]",
        )}
      />
    </button>
  );
}

function TransportBadge({ transport }: { transport: McpTransport }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1 text-[10.5px] text-ink-faint">
      {transport === "stdio" ? <Terminal className="size-3" /> : <Globe className="size-3" />}
      {transport === "stdio" ? "stdio" : transport === "sse" ? "SSE" : "HTTP"}
    </span>
  );
}

function ServerRow(props: {
  config: McpServerConfig;
  active: boolean;
  busy: boolean;
  collision: boolean;
  onSelect: () => void;
  onToggle: () => void;
}): ReactNode {
  const { config } = props;
  const total = config.discovery?.tools.length ?? 0;
  const picked = includedTools(config).length;

  // A row is two controls, not one: the switch decides whether the server is in
  // the registry, the rest of the row decides what the panel is showing. They
  // are siblings rather than nested (a `<button>` inside a `<button>` is
  // invalid HTML and React says so out loud).
  return (
    <div
      data-testid="mcp-server-row"
      data-server-name={config.name}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 transition-colors duration-150",
        props.active
          ? "border-accent/50 bg-accent-soft"
          : "border-line bg-surface-2 hover:border-line-strong hover:bg-surface-3",
      )}
    >
      <Switch checked={config.enabled} onChange={props.onToggle} label={`Use ${config.name}`} />
      <button
        type="button"
        onClick={props.onSelect}
        aria-current={props.active ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring/70"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-medium text-ink">{config.name}</span>
            {props.busy ? <LoaderCircle className="size-3 shrink-0 animate-spin text-accent" /> : <StatusDot config={config} />}
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <code className="truncate font-mono text-[10.5px] text-ink-dim">tools.{config.namespace}.*</code>
            <TransportBadge transport={config.transport} />
          </span>
        </span>
        {props.collision ? <TriangleAlert className="size-3.5 shrink-0 text-warn" aria-label="Namespace already taken" /> : null}
        <span className="shrink-0 text-[10.5px] tabular-nums text-ink-faint">
          {total === 0 ? "—" : picked === total ? `${String(total)}` : `${String(picked)}/${String(total)}`}
        </span>
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* one server                                                                  */
/* -------------------------------------------------------------------------- */

function ServerDetail(props: {
  config: McpServerConfig;
  state: McpServersState;
  busy: boolean;
  collision: string | null;
  onDiscover: () => void;
}): ReactNode {
  const { config, state } = props;
  const [query, setQuery] = useState("");
  const [namespace, setNamespace] = useState(config.namespace);
  const [token, setToken] = useState(tokenFor(config) ?? "");

  const tools = config.discovery?.tools ?? [];
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (term.length === 0) return tools;
    return tools.filter((tool) =>
      `${tool.method} ${tool.toolName} ${tool.label} ${tool.description ?? ""}`.toLowerCase().includes(term),
    );
  }, [tools, query]);

  const picked = includedTools(config);

  /**
   * What this one server costs in AI context, on its own.
   *
   * Composed in isolation rather than read off the global registry: the
   * question a person asks while ticking boxes is "how much is *this* adding",
   * and the footer already answers "how much is everything".
   */
  const cost = useMemo(() => {
    if (picked.length === 0) return 0;
    try {
      const solo = compose([{ ...config, enabled: true }]);
      return estimateTokens(generateToolsDts(createRegistry({ tools: solo.registry.tools, functions: [] })));
    } catch {
      return 0;
    }
  }, [config, picked.length]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3 rounded-xl border border-line bg-surface-2 p-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="m-0 truncate text-[13.5px] font-semibold text-ink">{config.name}</h3>
            <StatusDot config={config} />
            {config.discovery === null ? null : (
              <Badge tone="neutral" title={`Discovered ${new Date(config.discovery.at).toLocaleString()}`}>
                {config.discovery.transport} · via {config.discovery.via}
              </Badge>
            )}
          </div>
          <p className="m-0 mt-1 truncate font-mono text-[11px] text-ink-dim">
            {config.transport === "stdio" ? formatCommand(config) : (config.url ?? "")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            size="md"
            data-testid="mcp-discover"
            disabled={props.busy}
            onClick={props.onDiscover}
          >
            {props.busy ? <LoaderCircle className="animate-spin" /> : <Plug />}
            {config.discovery === null ? "Connect" : "Re-discover"}
          </Button>
          <Hint label="Remove this server">
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${config.name}`}
              data-testid="mcp-remove"
              onClick={() => { state.removeServer(config.id); }}
            >
              <Trash2 />
            </Button>
          </Hint>
        </div>
      </div>

      {props.collision === null ? null : (
        <Notice tone="warn" title="Namespace collision">{props.collision}</Notice>
      )}

      {typeof config.error === "string" && config.error.length > 0 ? (
        <Notice tone="danger" title="This server did not answer">
          <span className="whitespace-pre-wrap">{config.error}</span>
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-start gap-5">
        <Field className="w-[16rem]">
          <FieldLabel htmlFor={`ns-${config.id}`}>Namespace</FieldLabel>
          <Input
            id={`ns-${config.id}`}
            mono
            data-testid="mcp-namespace"
            value={namespace}
            onChange={(event) => { setNamespace(event.target.value); }}
            onBlur={() => {
              const next = defaultNamespace(namespace);
              setNamespace(next);
              if (next !== config.namespace) state.updateServer(config.id, { namespace: next });
            }}
          />
          <FieldHint>
            Flow code will say <code className="font-mono">tools.{namespace || "…"}.method()</code>. Changing it
            renames every tool here, which makes the open diagram stale (06 §5).
          </FieldHint>
        </Field>

        {config.transport === "stdio" ? null : (
          <Field className="min-w-[18rem] flex-1">
            <FieldLabel htmlFor={`tok-${config.id}`}>
              {config.headerName === undefined || config.headerName.length === 0
                ? "Token header"
                : `${config.headerName} value`}
            </FieldLabel>
            <Input
              id={`tok-${config.id}`}
              type="password"
              mono
              placeholder={config.headerName === undefined || config.headerName.length === 0 ? "no header configured" : "Bearer …"}
              disabled={config.headerName === undefined || config.headerName.length === 0}
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                setSessionToken(config.id, event.target.value);
                if (config.rememberToken === true) state.updateServer(config.id, { headerValue: event.target.value });
              }}
            />
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-ink-dim">
              <input
                type="checkbox"
                className="size-3.5 cursor-pointer accent-[color:var(--cf-accent)]"
                checked={config.rememberToken === true}
                onChange={(event) => {
                  state.updateServer(config.id, {
                    rememberToken: event.target.checked,
                    ...(event.target.checked ? { headerValue: token } : { headerValue: undefined }),
                  });
                }}
              />
              Remember it in this browser — <strong className="font-semibold">stored as plain text in localStorage</strong>
            </label>
            <FieldHint>
              Left unticked, the value lives in this tab only and is asked for again after a reload.
            </FieldHint>
          </Field>
        )}
      </div>

      {tools.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[12.5px] text-ink-dim">
          {config.discovery === null
            ? "Not connected yet. Press Connect to ask this server what it can do."
            : "This server answered, but listed no tools."}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
              Tools in the registry
            </span>
            <Badge tone={picked.length === 0 ? "warn" : "neutral"}>
              {picked.length} of {tools.length}
            </Badge>
            <span className="text-[11.5px] text-ink-dim" data-testid="mcp-server-tokens">
              ≈ {cost.toLocaleString()} tokens of <code className="font-mono text-[11px]">tools.d.ts</code>
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
                <Input
                  className="h-8 w-[12rem] pl-7 text-[12px]"
                  placeholder="Filter tools"
                  value={query}
                  onChange={(event) => { setQuery(event.target.value); }}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                data-testid="mcp-select-all"
                onClick={() => { state.replaceServer(config.id, selectAll(config, true)); }}
              >
                All
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid="mcp-select-none"
                onClick={() => { state.replaceServer(config.id, selectAll(config, false)); }}
              >
                None
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {filtered.map((tool) => {
              const on = isSelected(config, tool.method);
              return (
                <label
                  key={tool.method}
                  data-testid="mcp-tool"
                  data-method={tool.method}
                  data-selected={on}
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors duration-150",
                    on ? "border-line-strong bg-surface-2" : "border-line bg-surface opacity-70 hover:opacity-100",
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 size-3.5 cursor-pointer accent-[color:var(--cf-accent)]"
                    checked={on}
                    onChange={() => { state.replaceServer(config.id, toggleTool(config, tool.method)); }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-1.5">
                      <code className="font-mono text-[11.5px] font-medium text-ink">{tool.method}</code>
                      {tool.toolName === tool.method ? null : (
                        <span className="truncate font-mono text-[10px] text-ink-faint">← {tool.toolName}</span>
                      )}
                    </span>
                    {tool.description === undefined ? null : (
                      <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-ink-dim">
                        {tool.description}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* add tab                                                                     */
/* -------------------------------------------------------------------------- */

function AddTab(props: {
  status: McpServerStatus;
  existing: readonly McpServerConfig[];
  onAdd: (config: McpServerConfig, onCommitted?: () => void) => void;
  busy: boolean;
}): ReactNode {
  const [kind, setKind] = useState<"remote" | "stdio">(props.status.stdio ? "stdio" : "remote");
  const [name, setName] = useState("");
  const [commandLine, setCommandLine] = useState("");
  const [url, setUrl] = useState("");
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  const [namespace, setNamespace] = useState("");

  useEffect(() => {
    if (!props.status.stdio) setKind("remote");
  }, [props.status.stdio]);

  const taken = new Set(props.existing.map((server) => server.namespace));
  const effectiveName = name.trim().length > 0 ? name.trim() : kind === "stdio" ? lastSegment(commandLine) : hostOf(url);
  const effectiveNamespace = namespace.trim().length > 0 ? defaultNamespace(namespace) : defaultNamespace(effectiveName);
  const collides = taken.has(effectiveNamespace);
  const ready = kind === "stdio" ? commandLine.trim().length > 0 : url.trim().length > 0;

  const submit = (): void => {
    if (!ready) return;
    const id = newServerId();
    const base: McpServerConfig = {
      id,
      name: effectiveName.length > 0 ? effectiveName : "MCP server",
      namespace: collides ? uniqueNamespace(effectiveNamespace, taken) : effectiveNamespace,
      transport: kind === "stdio" ? "stdio" : "http",
      enabled: true,
      selected: null,
      discovery: null,
    };
    if (kind === "stdio") {
      const parsed = parseCommand(commandLine);
      base.command = parsed.command;
      base.args = parsed.args;
    } else {
      base.url = url.trim();
      if (headerName.trim().length > 0) {
        base.headerName = headerName.trim();
        if (headerValue.length > 0) setSessionToken(id, headerValue);
      }
    }
    props.onAdd(base, () => {
      setName(""); setCommandLine(""); setUrl(""); setHeaderName(""); setHeaderValue(""); setNamespace("");
    });
  };

  const quickAdd = (entry: CatalogEntry): void => {
    const id = newServerId();
    const config: McpServerConfig = {
      id,
      name: entry.name,
      namespace: taken.has(entry.namespace) ? uniqueNamespace(entry.namespace, taken) : entry.namespace,
      transport: entry.transport,
      enabled: true,
      selected: null,
      discovery: null,
      catalogId: entry.id,
      ...(entry.command === undefined ? {} : { command: entry.command }),
      ...(entry.args === undefined ? {} : { args: entry.args }),
      ...(entry.url === undefined ? {} : { url: entry.url }),
    };
    props.onAdd(config);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-line bg-surface-2 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented<"remote" | "stdio">
            aria-label="Transport"
            value={kind}
            onValueChange={setKind}
            items={[
              { value: "remote", label: "Remote URL", icon: <Globe />, hint: "A Streamable-HTTP or SSE endpoint. Works in the hosted build too." },
              { value: "stdio", label: "Local command", icon: <Terminal />, hint: "Starts a process on this machine. Local checkouts only." },
            ]}
          />
          {props.status.stdio ? null : (
            <span className="text-[11.5px] text-ink-dim">{props.status.stdioReason}</span>
          )}
        </div>

        <div className="mt-4 flex flex-col gap-4">
          {kind === "stdio" ? (
            <Field>
              <FieldLabel htmlFor="mcp-command">Command</FieldLabel>
              <Input
                id="mcp-command"
                mono
                data-testid="mcp-command"
                disabled={!props.status.stdio}
                placeholder="npx -y @modelcontextprotocol/server-filesystem /tmp/scratch"
                value={commandLine}
                onChange={(event) => { setCommandLine(event.target.value); }}
                onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
              />
              <FieldHint>
                Split on spaces and handed to <code className="font-mono">spawn</code> — there is no shell.
                It runs on this machine with your permissions.
              </FieldHint>
            </Field>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="mcp-url">Endpoint URL</FieldLabel>
                <Input
                  id="mcp-url"
                  mono
                  data-testid="mcp-url"
                  placeholder="https://mcp.example.com/mcp"
                  value={url}
                  onChange={(event) => { setUrl(event.target.value); }}
                  onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
                />
                <FieldHint>
                  Streamable HTTP is tried first, then SSE. The browser calls it directly when the
                  endpoint allows cross-origin requests; otherwise the dev server does.
                </FieldHint>
              </Field>
              <div className="flex flex-wrap gap-3">
                <Field className="w-[13rem]">
                  <FieldLabel htmlFor="mcp-header">Header name <span className="font-normal text-ink-faint">optional</span></FieldLabel>
                  <Input
                    id="mcp-header"
                    mono
                    placeholder="Authorization"
                    value={headerName}
                    onChange={(event) => { setHeaderName(event.target.value); }}
                  />
                </Field>
                <Field className="min-w-[14rem] flex-1">
                  <FieldLabel htmlFor="mcp-header-value">Header value</FieldLabel>
                  <Input
                    id="mcp-header-value"
                    mono
                    type="password"
                    placeholder="Bearer …"
                    disabled={headerName.trim().length === 0}
                    value={headerValue}
                    onChange={(event) => { setHeaderValue(event.target.value); }}
                  />
                  <FieldHint>Kept in this tab only until you tick “remember” on the server itself.</FieldHint>
                </Field>
              </div>
            </>
          )}

          <div className="flex flex-wrap items-start gap-3">
            <Field className="w-[14rem]">
              <FieldLabel htmlFor="mcp-name">Name <span className="font-normal text-ink-faint">optional</span></FieldLabel>
              <Input
                id="mcp-name"
                placeholder={effectiveName.length > 0 ? effectiveName : "My server"}
                value={name}
                onChange={(event) => { setName(event.target.value); }}
              />
            </Field>
            <Field className="w-[12rem]">
              <FieldLabel htmlFor="mcp-ns">Namespace</FieldLabel>
              <Input
                id="mcp-ns"
                mono
                placeholder={effectiveNamespace}
                value={namespace}
                onChange={(event) => { setNamespace(event.target.value); }}
              />
              <FieldHint>
                {collides
                  ? `Taken — it will become ${uniqueNamespace(effectiveNamespace, taken)}.`
                  : `tools.${effectiveNamespace || "…"}.*`}
              </FieldHint>
            </Field>
            <Button
              variant="primary"
              size="md"
              className="mt-[1.6rem]"
              data-testid="mcp-add"
              disabled={!ready || props.busy || (kind === "stdio" && !props.status.stdio)}
              onClick={submit}
            >
              {props.busy ? <LoaderCircle className="animate-spin" /> : <Plus />}
              Add and connect
            </Button>
          </div>
        </div>
      </div>

      {CATALOG.length === 0 ? null : (
        <div className="flex flex-col gap-3">
          <div>
            <p className="m-0 text-[12.5px] font-semibold text-ink">Quick add</p>
            <p className="m-0 text-[11.5px] text-ink-dim">
              Servers that need no account and no key. Every one was connected to and its tools listed
              before it was put on this list; the count is what it answered then.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {[...REMOTE_CATALOG, ...(props.status.stdio ? STDIO_CATALOG : [])].map((entry) => (
              <button
                key={entry.id}
                type="button"
                data-testid="mcp-quick-add"
                data-entry={entry.id}
                disabled={props.busy}
                onClick={() => { quickAdd(entry); }}
                className={cn(
                  "flex flex-col gap-1.5 rounded-lg border border-line bg-surface-2 p-3 text-left",
                  "transition-colors duration-150 hover:border-line-strong hover:bg-surface-3",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-medium text-ink">{entry.name}</span>
                  <TransportBadge transport={entry.transport} />
                  <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-ink-faint">
                    {entry.tools} tools
                  </span>
                </span>
                <span className="line-clamp-2 text-[11px] leading-snug text-ink-dim">{entry.description}</span>
                {entry.note === undefined ? null : (
                  <span className="text-[10.5px] text-warn">{entry.note}</span>
                )}
                {/* An endpoint that refuses cross-origin calls needs the dev
                    server to make them. Where there is none, say so *before*
                    the click rather than after it. */}
                {entry.transport !== "stdio" && entry.cors !== true && !props.status.available ? (
                  <span className="text-[10.5px] text-danger">
                    This one refuses browser-direct calls, and this build has no server to call it for you.
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          {props.status.stdio ? null : (
            <p className="m-0 text-[11px] text-ink-faint">
              {STDIO_CATALOG.length} local-command entries are hidden because this build cannot start
              a process.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* tools.d.ts tab                                                              */
/* -------------------------------------------------------------------------- */

function DtsTab(props: { lookup: RegistryLookup; fromMcp: boolean; fallbackLabel: string }): ReactNode {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const generated = useMemo(() => {
    try {
      return { text: generateToolsDts(props.lookup), error: null as string | null };
    } catch (cause) {
      return { text: "", error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [props.lookup]);
  const cost = useMemo(() => tokenCostOf(props.lookup), [props.lookup]);

  return (
    <div className="flex min-h-[26rem] flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="m-0 text-[12.5px] leading-relaxed text-ink-dim">
          Generated from the registry above — the same file the analyzer resolves calls against, the
          AI writes code from, and the runtime binds (05 §2). {props.fromMcp ? "It is your servers." : `Right now it is ${props.fallbackLabel}.`}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11.5px] text-ink-dim" data-testid="mcp-dts-tokens">
            ≈ {cost.dts.toLocaleString()} tokens · whole prompt ≈ {cost.context.toLocaleString()}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={generated.text.length === 0}
            onClick={() => {
              void navigator.clipboard.writeText(generated.text).then(
                () => {
                  setCopied(true);
                  setTimeout(() => { setCopied(false); }, 1600);
                },
                () => { toast.add({ title: "Could not copy", description: "This browser refused clipboard access." }); },
              );
            }}
          >
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>

      {generated.error === null ? (
        <pre
          data-testid="mcp-dts"
          className="cf-scroll m-0 max-h-[32rem] flex-1 overflow-auto rounded-xl border border-line bg-surface-2 p-4 font-mono text-[11.5px] leading-[1.55] text-ink"
        >
          {generated.text}
        </pre>
      ) : (
        <Notice tone="danger" title="This registry cannot be generated">{generated.error}</Notice>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* small helpers                                                               */
/* -------------------------------------------------------------------------- */

function lastSegment(commandLine: string): string {
  const { args, command } = parseCommand(commandLine);
  const pkg = args.find((arg) => !arg.startsWith("-")) ?? command;
  return pkg.replace(/^@[^/]+\//, "").replace(/^(?:mcp-)?server-/, "") || "MCP server";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^(?:www|mcp)\./, "");
  } catch {
    return "";
  }
}

function uniqueNamespace(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}${String(suffix)}`;
    if (!taken.has(candidate)) return candidate;
  }
}
