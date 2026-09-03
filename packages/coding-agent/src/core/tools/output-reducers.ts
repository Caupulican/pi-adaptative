/**
 * The bundled reducers, registered in precedence order. Import this module (not the individual
 * reducers) wherever reduction must be live: the bash and python tools and the census replay all
 * see the same registry.
 */
import { diagnosticsOutputReducer } from "./diagnostics-output-reducer.ts";
import { jsonOutputReducer } from "./json-output-reducer.ts";
import { registeredOutputReducers, registerOutputReducer } from "./output-reduction.ts";
import { searchOutputReducer } from "./search-output-reducer.ts";

const BUNDLED = [searchOutputReducer, diagnosticsOutputReducer, jsonOutputReducer];

/** Idempotent: a second call (hot reload, a second importer) changes nothing. */
export function ensureOutputReducersRegistered(): void {
	for (const reducer of BUNDLED) registerOutputReducer(reducer);
}

ensureOutputReducersRegistered();

export { registeredOutputReducers };
