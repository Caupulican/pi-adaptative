import childProcess from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import nativeProcess from "node:process";
import { wrapBuiltinModule } from "./builtin-boundary.ts";

/** Must be the first side-effect import, before production modules capture operations tables. */
wrapBuiltinModule({ default: fs }, "fs");
wrapBuiltinModule({ default: fsPromises }, "fsPromises");
wrapBuiltinModule({ default: childProcess }, "process");
const signals = wrapBuiltinModule({ default: { kill: nativeProcess.kill } }, "hostProcess");
// Vitest can expose a copied global process object while native TypeScript reads Node's singleton.
// Both references use the same stable dispatcher; neither captures a per-world signal implementation.
for (const target of new Set([process, nativeProcess])) target.kill = signals.kill as typeof process.kill;
const sqlite = process.getBuiltinModule("node:sqlite");
if (sqlite) wrapBuiltinModule(sqlite, "sqlite");
const threads = process.getBuiltinModule("node:worker_threads");
if (threads) wrapBuiltinModule(threads, "workerThreads");
syncBuiltinESMExports();
