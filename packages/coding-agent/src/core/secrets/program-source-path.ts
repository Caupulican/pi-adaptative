/**
 * The one question "is this path program source": a path the scanner has a dialect for, which is the condition the
 * credential mask needs to follow free text across lines.
 */

import { sourceDialectOf } from "../security/source-scanner.ts";

/**
 * Data and configuration formats (json, yaml, toml, ini, env, xml, properties, markup) are not source: there an
 * unquoted scalar is a value. Shell and PowerShell scripts are data in this sense too, and so is a path with no
 * extension or one no dialect covers.
 */
export function isProgramSourcePath(path: string): boolean {
	return sourceDialectOf(path) !== undefined;
}
