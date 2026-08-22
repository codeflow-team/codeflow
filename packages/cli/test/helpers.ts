import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const created: string[] = [];

/**
 * A scratch workspace under the OS temp dir — deliberately outside the repo, so
 * nothing here can resolve project modules by accident and the config really is
 * loaded the way a user's would be.
 */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codeflow-cli-"));
  created.push(dir);
  return dir;
}

export async function cleanup(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export async function write(root: string, relative: string, content: string): Promise<string> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return file;
}

/** Collects what `run()` printed, so CLI behaviour can be asserted without a subprocess. */
export function captureIo(): { out: string[]; err: string[]; io: { out(t: string): void; err(t: string): void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t) => void out.push(t), err: (t) => void err.push(t) } };
}
