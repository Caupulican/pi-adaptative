#!/usr/bin/env node

/**
 * Syncs all workspace package dependency versions to match their current versions.
 * This ensures lockstep versioning across the monorepo.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const packagesDir = join(process.cwd(), 'packages');
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
	.filter(dirent => dirent.isDirectory())
	.map(dirent => dirent.name);

// Read all package.json files and build version map
const packages = {};
const versionMap = {};

for (const dir of packageDirs) {
	const pkgPath = join(packagesDir, dir, 'package.json');
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		packages[dir] = { path: pkgPath, data: pkg };
		versionMap[pkg.name] = pkg.version;
	} catch (e) {
		console.error(`Failed to read ${pkgPath}:`, e.message);
	}
}

console.log('Current versions:');
for (const [name, version] of Object.entries(versionMap).sort()) {
	console.log(`  ${name}: ${version}`);
}

// Verify all versions are the same (lockstep)
const versions = new Set(Object.values(versionMap));
if (versions.size > 1) {
	console.error('\n❌ ERROR: Not all packages have the same version!');
	console.error('Expected lockstep versioning. Run one of:');
	console.error('  npm run version:patch');
	console.error('  npm run version:minor');
	console.error('  npm run version:major');
	process.exit(1);
}

console.log('\n✅ All packages at same version (lockstep)');

function syncDependencyGroup(pkg, field) {
	const dependencies = pkg.data[field];
	if (!dependencies) return 0;
	let updates = 0;
	for (const [depName, currentVersion] of Object.entries(dependencies)) {
		if (!versionMap[depName]) continue;
		const newVersion = `^${versionMap[depName]}`;
		if (currentVersion === newVersion) continue;
		console.log(`\n${pkg.data.name}:`);
		const suffix = field === 'devDependencies' ? ' (devDependencies)' : '';
		console.log(`  ${depName}: ${currentVersion} → ${newVersion}${suffix}`);
		dependencies[depName] = newVersion;
		updates++;
	}
	return updates;
}

// Update all inter-package dependencies
let totalUpdates = 0;
for (const pkg of Object.values(packages)) {
	const packageUpdates = syncDependencyGroup(pkg, 'dependencies') + syncDependencyGroup(pkg, 'devDependencies');
	totalUpdates += packageUpdates;
	
	// Write if updated
	if (packageUpdates > 0) {
		writeFileSync(pkg.path, JSON.stringify(pkg.data, null, '\t') + '\n');
	}
}

if (totalUpdates === 0) {
	console.log('\nAll inter-package dependencies already in sync.');
} else {
	console.log(`\n✅ Updated ${totalUpdates} dependency version(s)`);
}
