// Evaluate a small synthetic TypeScript fixture and serialize its observations inside the bounded VM turn.
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

export function fixtureObservation(source, expression) {
	const compiled = transformSync(source, { loader: "ts", format: "cjs", target: "es2022" }).code;
	return runInNewContext(
		`const module = { exports: {} }; const exports = module.exports;\n${compiled}\nJSON.stringify(${expression});`,
		Object.create(null),
		{ timeout: 1000, contextCodeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" },
	);
}
