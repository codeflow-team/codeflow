/**
 * Ship the stylesheets next to the compiled output — `tsc` only emits JS/d.ts.
 *
 * `styles.css` is a Tailwind entry, so it is *compiled* (the `build` script runs
 * the Tailwind CLI over it before this script runs) and only `tokens.css` is
 * copied verbatim: a host that wants the design tokens without the component
 * CSS — to build its own chrome against the same palette — imports that one.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = resolve(here, "../src/tokens.css");
const to = resolve(here, "../dist/tokens.css");

await mkdir(dirname(to), { recursive: true });
await copyFile(from, to);
