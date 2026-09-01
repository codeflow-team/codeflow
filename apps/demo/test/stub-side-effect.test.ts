/**
 * A stub returns a shape; it cannot have a side effect — and the run says so.
 *
 * `browser.snapshot({ filename })` exists to write a file. With no Playwright
 * server on the allowlist it is answered from its declared output schema, so
 * nothing is written, and the next step — a *real* filesystem call — dies with
 * `ENOENT` about a path nothing in the flow looks wrong for. The error is true
 * and tells the reader nothing.
 *
 * Two places say what happened, because a flow may catch its own errors (the QA
 * example does, so the worker's top-level handler never sees them): the stub
 * call itself carries the explanation, and a crash that names a promised path
 * gets it appended.
 *
 * What is deliberately NOT done: seeding the snapshot files. That would let the
 * flow finish and publish a QA report saying tests passed when no browser ever
 * opened — worse than failing.
 */

import { describe, expect, it } from "vitest";
import { explainStubbedPath, workspacePathsIn } from "../server/stub-paths.ts";

const WORKSPACE = "/tmp/codeflow-run-abc/workspace";

describe("explaining a path a stub never wrote", () => {
  const promised = new Map([[`${WORKSPACE}/QA-1.snapshot.txt`, "browser.snapshot"]]);

  it("names the tool that promised the file", () => {
    const message = `read_text_file: ENOENT: no such file or directory, open '${WORKSPACE}/QA-1.snapshot.txt'`;
    const explained = explainStubbedPath(message, promised);
    expect(explained).toContain("browser.snapshot");
    expect(explained).toContain("has no server behind it");
    // The original error survives — the explanation is added, never substituted.
    expect(explained).toContain("ENOENT");
  });

  it("says nothing about a failure it cannot explain", () => {
    // Never put words on an error that has nothing to do with a stub.
    expect(explainStubbedPath("EACCES: permission denied, open '/etc/shadow'", promised)).toBeNull();
    expect(explainStubbedPath("some other failure entirely", promised)).toBeNull();
  });

  it("says nothing when no stub promised anything", () => {
    const message = `ENOENT: no such file or directory, open '${WORKSPACE}/QA-1.snapshot.txt'`;
    expect(explainStubbedPath(message, new Map())).toBeNull();
  });
});

describe("which arguments count as a promise", () => {
  it("takes workspace paths, at any depth, and shows them by name", () => {
    const found = workspacePathsIn(
      { filename: `${WORKSPACE}/QA-1.snapshot.txt`, opts: { extra: [`${WORKSPACE}/logs/net.json`] } },
      WORKSPACE,
    );
    expect(found.shown).toEqual(["QA-1.snapshot.txt", "logs/net.json"]);
    expect(found.absolute[0]).toBe(`${WORKSPACE}/QA-1.snapshot.txt`);
  });

  it("ignores anything that is not a path into this run's workspace", () => {
    // A stub handed a URL, a sentence, or somebody else's directory has
    // promised nothing about this filesystem.
    const found = workspacePathsIn(
      { url: "https://example.invalid/checkout", note: "click #basket", other: "/etc/hosts" },
      WORKSPACE,
    );
    expect(found.shown).toEqual([]);
  });
});
