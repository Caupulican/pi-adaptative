import { DEPENDENCY_FORKS } from "../dependency-forks/definitions.mjs";

export const requiredSecurityOverrides = new Map([
	["nanoid", "3.3.18"],
	["brace-expansion", "5.0.12"],
]);

const requiredSelectorSecurityOverrides = [
	{ selector: "undici@7", packageName: "undici", major: 7, version: "7.29.1" },
	{ selector: "undici@8", packageName: "undici", major: 8, version: "8.10.2" },
];

export function validateRequiredSecurityOverrides(rootPackage, rootLockfile, codingAgentPackage) {
	const failures = [];
	for (const fork of DEPENDENCY_FORKS) {
		const expected = `file:./${fork.directory}`;
		if (rootPackage.overrides?.[fork.original] !== `$${fork.original}` || rootPackage.devDependencies?.[fork.original] !== expected)
			failures.push(`package.json: overrides.${fork.original} must use the pinned local fork ${expected}`);
	}
	for (const [name, requiredVersion] of requiredSecurityOverrides) {
		const overrideVersion = rootPackage.overrides?.[name];
		if (overrideVersion !== requiredVersion) {
			failures.push(`package.json: overrides.${name} must be ${requiredVersion}, found ${overrideVersion ?? "missing"}`);
		}

		const resolvedVersion = rootLockfile.packages?.[`node_modules/${name}`]?.version;
		if (resolvedVersion === undefined) {
			failures.push(
				`package-lock.json: node_modules/${name} must resolve to ${requiredVersion}, found ${resolvedVersion ?? "missing"}`,
			);
		}
	}
	for (const { selector, packageName, major, version } of requiredSelectorSecurityOverrides) {
		const overrideVersion = rootPackage.overrides?.[selector];
		if (overrideVersion !== version) {
			failures.push(`package.json: overrides.${selector} must be ${version}, found ${overrideVersion ?? "missing"}`);
		}

		const matchingEntries = Object.entries(rootLockfile.packages ?? {}).filter(([path, entry]) => {
			if (path !== `node_modules/${packageName}` && !path.endsWith(`/node_modules/${packageName}`)) return false;
			return typeof entry.version === "string" && entry.version.startsWith(`${major}.`);
		});
		if (matchingEntries.length === 0) {
			failures.push(`package-lock.json: ${selector} must have an installed resolution`);
		}
		for (const [path, entry] of matchingEntries) {
			if (entry.version !== version) {
				failures.push(`package-lock.json: ${path} must resolve to ${version}, found ${entry.version ?? "missing"}`);
			}
		}
	}

	const directUndiciVersion = requiredSelectorSecurityOverrides.find((required) => required.selector === "undici@8").version;
	if (codingAgentPackage?.dependencies?.undici !== directUndiciVersion) {
		failures.push(
			`packages/coding-agent/package.json: dependencies.undici must be ${directUndiciVersion}, found ${codingAgentPackage?.dependencies?.undici ?? "missing"}`,
		);
	}
	for (const [name, version] of Object.entries(rootPackage.overrides ?? {})) {
		if (typeof version !== "string") continue;
		if (requiredSelectorSecurityOverrides.some((required) => required.selector === name)) continue;
		const fork = DEPENDENCY_FORKS.find((entry) => entry.original === name);
		if (fork) {
			let found = false;
			for (const [path, entry] of Object.entries(rootLockfile.packages ?? {})) {
				if (path !== `node_modules/${name}` && !path.endsWith(`/node_modules/${name}`)) continue;
				found = true;
				const target = rootLockfile.packages?.[fork.directory];
				if (entry.link !== true || entry.resolved !== fork.directory || !target || target.link ||
					target.version !== fork.version || (target.name !== undefined && target.name !== fork.name))
					failures.push(`package-lock.json: ${path} must resolve to ${fork.name}@${fork.version}`);
			}
			if (!found) failures.push(`package-lock.json: ${name} must have a hardened installed resolution`);
			continue;
		}
		for (const [path, entry] of Object.entries(rootLockfile.packages ?? {})) {
			if (path !== `node_modules/${name}` && !path.endsWith(`/node_modules/${name}`)) continue;
			if (entry.version !== version) {
				failures.push(`package-lock.json: ${path} must resolve to ${version}, found ${entry.version ?? "missing"}`);
			}
		}
	}
	return failures;
}
