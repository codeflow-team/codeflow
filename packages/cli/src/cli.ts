#!/usr/bin/env node
/** Entry point for the `codeflow` binary — 02-architecture.md §2. */

import { run } from "./run.js";

process.exitCode = await run(process.argv.slice(2));
