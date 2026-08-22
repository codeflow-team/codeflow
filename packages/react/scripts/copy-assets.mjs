// Ship the stylesheet next to the compiled output — `tsc` only emits JS/d.ts.
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = resolve(here, "../src/styles.css");
const to = resolve(here, "../dist/styles.css");

await mkdir(dirname(to), { recursive: true });
await copyFile(from, to);
