export const requiredSecurityOverrides = new Map([["nanoid", "3.3.18"]]);

export function validateRequiredSecurityOverrides(rootPackage, rootLockfile) {
	const failures = [];
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
	for (const [name, version] of Object.entries(rootPackage.overrides ?? {})) {
		if (typeof version !== "string") continue;
		for (const [path, entry] of Object.entries(rootLockfile.packages ?? {})) {
			if (path !== `node_modules/${name}` && !path.endsWith(`/node_modules/${name}`)) continue;
			if (entry.version !== version) {
				failures.push(`package-lock.json: ${path} must resolve to ${version}, found ${entry.version ?? "missing"}`);
			}
		}
	}
	return failures;
}
