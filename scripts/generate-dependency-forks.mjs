import { resolve } from "node:path";
import { DEPENDENCY_FORKS, verifyDependencyFork } from "./lib/dependency-fork-builder.mjs";

const write = process.argv.includes("--write");
for (const definition of DEPENDENCY_FORKS) {
	const count = verifyDependencyFork(resolve(import.meta.dirname, ".."), definition, write);
	console.log(`${definition.name}: ${count} source-pinned files ${write ? "generated/verified" : "verified"}; ${definition.advisory}`);
}
