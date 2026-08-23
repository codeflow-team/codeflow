/**
 * Example prompts, keyed by registry.
 *
 * A suggestion is a promise about what a flow's registry contains, so it is
 * keyed by registry rather than written once: offering "read every file in
 * /tmp/logs" to a flow whose only tools are GitHub and Slack sets the model up
 * to fail and teaches the reader the wrong thing about the contract. Registries
 * with nothing written for them fall back to shapes rather than tool names.
 *
 * This lived inside `ChatPanel.tsx` until the create dialog needed the same
 * promise for the same reason. One list, two surfaces.
 */

const OPENERS: Record<string, string[]> = {
  sample: [
    "For every new pull request, post its title to #releases",
    "Alert #oncall when a pull request changes more than ten files",
    "Read each PR's files and skip the ones that only touch tests",
  ],
  "repo-triage": [
    "Read every file in the repository root and remember the risky ones",
    "Walk the allowed directories and write a summary file for each one",
    "Search memory for what changed last run, then re-read only those files",
  ],
  research: [
    "Search the web for a topic, read the top result, and file a brief",
    "Ask three sources in parallel and keep whichever answers first",
    "Retry the search up to three times before giving up",
  ],
  "browser-qa": [
    "Open a page, take a snapshot, and save it next to the report",
    "Click through a login form and screenshot whatever comes back",
    "Retry a failing step twice, then close the browser either way",
  ],
  pipeline: [
    "Read every CSV in the drop folder and total them by region",
    "Enrich each row from three sources at once, then write the ledger",
    "Stop the whole run if any file fails to parse",
  ],
};

const GENERIC_OPENERS = [
  "Do the first step, then loop over whatever it gives back",
  "Wrap the risky step in a try and report the failure",
  "Run the independent steps in parallel, then join the results",
];

/**
 * Openers for a registry id.
 *
 * A composed MCP registry has an id nobody wrote openers for — and could not,
 * since its tools are the visitor's. It gets the shape-based ones, which name
 * no tool and therefore promise nothing that might not be there.
 */
export function openersFor(registryId: string): string[] {
  return OPENERS[registryId] ?? GENERIC_OPENERS;
}

/**
 * Openers that name a namespace the registry actually has.
 *
 * For a registry with no written openers — every composed MCP one — the generic
 * shapes are prefixed with a real namespace from the registry, so the newcomer's
 * first prompt still points at a tool the model can reach.
 */
export function openersForRegistry(registryId: string, namespaces: readonly string[]): string[] {
  const written = OPENERS[registryId];
  if (written !== undefined) return written;
  const first = namespaces[0];
  if (first === undefined) return GENERIC_OPENERS;
  const second = namespaces[1];
  return [
    `Call one ${first} tool, then loop over whatever it gives back`,
    `Wrap the ${first} step in a try and report the failure`,
    // One namespace is not two, and "ask deepwiki and deepwiki in parallel" is
    // a suggestion that teaches nothing.
    second === undefined
      ? `Run two ${first} calls in parallel, then join the results`
      : `Ask ${first} and ${second} in parallel, then join the results`,
  ];
}
