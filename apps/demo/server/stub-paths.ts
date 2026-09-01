/**
 * What a stubbed tool promised and did not deliver.
 *
 * A tool with no server behind it is answered from its declared output schema:
 * it returns a shape and changes nothing. For a tool whose whole point is a
 * side effect — `browser.snapshot({ filename })` — that means the file it names
 * never appears, and the next step, which may be a *real* server, dies with
 * `ENOENT` about a path nothing in the flow looks wrong for. The error is true
 * and tells the reader nothing.
 *
 * Extracted from `worker.ts` for the same reason `probe.ts` was: that module
 * throws at import time without a `parentPort`, so nothing in it can be tested.
 */

/**
 * The workspace paths inside a call's arguments.
 *
 * `absolute` is for bookkeeping, `shown` is for reading: the scratch directory
 * is a temporary folder nobody recognises, so a message says `QA-1.snapshot.txt`
 * rather than `/private/var/folders/n0/…/workspace/QA-1.snapshot.txt`.
 *
 * Only paths inside the run's own workspace count. A stub handed a URL or a
 * sentence has promised nothing about the filesystem, and saying it did would
 * be the same invention this exists to prevent.
 */
export function workspacePathsIn(
  args: unknown,
  scratch: string,
): { absolute: string[]; shown: string[] } {
  const absolute: string[] = [];
  const shown: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.startsWith(scratch)) {
        absolute.push(value);
        shown.push(value.slice(scratch.length).replace(/^\/+/, ""));
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(args);
  return { absolute, shown };
}

/**
 * The sentence that turns a true-but-useless error into what happened.
 *
 * Returns `null` when the failure has nothing to do with a stub, so this can
 * never put words on an error it does not explain. The original message is kept
 * whole: the explanation is added to it, never substituted for it.
 */
export function explainStubbedPath(
  message: string,
  promised: ReadonlyMap<string, string>,
): string | null {
  for (const [path, tool] of promised) {
    if (!message.includes(path)) continue;
    return `${message}\n\nThat file does not exist because \`${tool}\` has no server behind it here — it was answered from its declared output schema, so it wrote nothing. A stub can return a shape; it cannot have the side effect the flow is relying on.`;
  }
  return null;
}
