import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "..");
const source = join(repository, "packages/coding-agent/examples/extensions/sandbox");
const temporary = mkdtempSync(join(tmpdir(), "pi-sandbox-fork-install-"));
try {
	for (const name of ["package.json", "package-lock.json", "vendor"])
		cpSync(join(source, name), join(temporary, name), { recursive: true });
	const npmCli = process.env.npm_execpath;
	if (!npmCli) throw new Error("Run this installed-source check through npm run check:sandbox-fork-install");
	execFileSync(process.execPath, [npmCli, "ci", "--ignore-scripts", "--install-links=false", "--no-fund"], { cwd: temporary, stdio: "inherit" });
	const require = createRequire(join(temporary, "package.json"));
	const sdkRequire = createRequire(require.resolve("@anthropic-ai/sandbox-runtime"));
	const entry = realpathSync(sdkRequire.resolve("node-forge"));
	assert.equal(entry, realpathSync(join(temporary, "vendor/pi-certificate-codec/lib/index.js")));
	const metadata = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8"));
	assert.equal(metadata.name, "pi-certificate-codec");
	const codec = sdkRequire("node-forge");
	assert.ok(codec.pki.rsa.setPublicKey.toString().includes("hasCanonicalDigestAlgorithm"));
	const expected = readFileSync(join(source, "vendor/pi-certificate-codec/lib/rsa.js"));
	assert.ok(readFileSync(entry.replace(/index\.js$/, "rsa.js")).equals(expected));
	console.log("Standalone sandbox install resolves the packaged hardened certificate codec; no lifecycle scripts executed.");
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
