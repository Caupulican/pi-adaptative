import childProcess from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { wrapBuiltinModule } from "./builtin-boundary.ts";

/** Must be the first side-effect import, before production modules capture operations tables. */
wrapBuiltinModule({ default: fs }, "fs");
wrapBuiltinModule({ default: fsPromises }, "fsPromises");
wrapBuiltinModule({ default: childProcess }, "process");
const signals = wrapBuiltinModule({ default: { kill: process.kill } }, "hostProcess");
process.kill = signals.kill as typeof process.kill;
const sqlite = process.getBuiltinModule("node:sqlite");
if (sqlite) wrapBuiltinModule(sqlite, "sqlite");
const threads = process.getBuiltinModule("node:worker_threads");
if (threads) wrapBuiltinModule(threads, "workerThreads");
syncBuiltinESMExports();
