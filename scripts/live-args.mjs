/** Command-line reading shared by the live acceptance scripts (`--name value` flags and bare switches). */
export const args = process.argv.slice(2);

/** The value after `--name`, or `fallback` when the flag is absent or has no value. */
export const flag = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

/** The required `--out` directory of an export script; exit 2 with the script's name when it is absent. */
export const requireOut = (tool) => {
	const out = flag("out", undefined);
	if (!out) {
		console.error(`${tool}: --out <dir> is required.`);
		process.exit(2);
	}
	return out;
};
