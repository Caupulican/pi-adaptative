import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { DEPENDENCY_FORKS, verifyDependencyFork } from "./lib/dependency-fork-builder.mjs";
import { createMitmCA, disposeMitmCA, generateCa, validateCaPair } from "../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js";
import { mintLeafCert, secureContextFor } from "../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const patterns = require("braces");
const certificateCodec = require("node-forge");

function referencePackage(context, name) {
	const definition = DEPENDENCY_FORKS.find((entry) => entry.original === name);
	const directory = mkdtempSync(join(tmpdir(), "pi-fork-negative-"));
	context.after(() => rmSync(directory, { recursive: true, force: true }));
	const bytes = readFileSync(join(root, definition.archive));
	assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, definition.integrity);
	execFileSync("tar", ["-xzf", join(root, definition.archive), "-C", directory]);
	if (name === "braces") {
		// Only the independent upstream control needs its original single dependency.
		const packageRequire = createRequire(join(directory, "package", "index.js"));
		// Node resolves this dependency through a local node_modules directory, not a model mock.
		cpSync(dirname(require.resolve("fill-range/package.json")), join(directory, "package", "node_modules", "fill-range"), { recursive: true });
		cpSync(dirname(require.resolve("to-regex-range/package.json")), join(directory, "package", "node_modules", "to-regex-range"), { recursive: true });
		cpSync(dirname(require.resolve("is-number/package.json")), join(directory, "package", "node_modules", "is-number"), { recursive: true });
		return packageRequire("./index.js");
	}
	return createRequire(join(directory, "package", "lib", "index.js"))("./index.js");
}

test("generated adapters exactly reproduce pinned upstream sources plus owned patches", () => {
	for (const definition of DEPENDENCY_FORKS) assert.ok(verifyDependencyFork(root, definition) > 0);
});

test("real consumers resolve the hardened adapters, not upstream registry modules", () => {
	for (const [consumer, name] of [["micromatch", "braces"], ["@anthropic-ai/sandbox-runtime", "node-forge"], ["postcss", "source-map-js"], ["@vitest/coverage-v8", "magicast"], ["magicast", "source-map-js"]]) {
		const definition = DEPENDENCY_FORKS.find((entry) => entry.original === name);
		const consumerRequire = createRequire(require.resolve(consumer));
		const expected = realpathSync(join(root, definition.directory, definition.main));
		assert.equal(realpathSync(consumerRequire.resolve(name)), expected);
		const metadata = JSON.parse(readFileSync(join(root, definition.directory, "package.json"), "utf8"));
		assert.equal(metadata.name, definition.name);
		assert.equal(metadata.version, definition.version);
	}
});

test("near-limit strings retain upstream controls while Pi enforces its declared nesting budget", (context) => {
	const upstream = referencePackage(context, "braces");
	for (const [open, close] of [["{", "}"], ["(", ")"]]) {
		const pattern = open.repeat(4999) + "a" + close.repeat(4999);
		// Original stack capacity varies by runtime; permit only success or the precise old fault.
		// The direct-AST case below retains an unconditional original stack-overflow oracle.
		try { assert.equal(upstream.compile(pattern), pattern); }
		catch (error) { assert.match(error.message, /call stack/i); context.diagnostic("Original near-limit string overflowed on this runtime"); }
		assert.throws(() => patterns.compile(pattern), /Pi pattern nesting limit/);
	}
	for (const pattern of ["{a,b}", "path/{one,two}/file", "{1..10}", "(a|b)", "\\{literal\\}"])
		assert.deepEqual(patterns(pattern), upstream(pattern));
	assert.equal(patterns.compile("{".repeat(128) + "a" + "}".repeat(128)), "{".repeat(128) + "a" + "}".repeat(128));
});

test("direct AST entries bypass the upstream string limit and exhaust the stack, not Pi's bounded traversal", (context) => {
	const upstream = referencePackage(context, "braces");
	const createDeepAst = () => {
		let node = { type: "text", value: "x" };
		for (let depth = 0; depth < 20000; depth++) node = { type: "paren", nodes: [node] };
		return node;
	};
	for (const method of ["compile", "stringify", "expand"]) {
		assert.throws(() => upstream[method](createDeepAst()), /call stack/i);
		assert.throws(() => patterns[method](createDeepAst()), /Pi pattern containment limit/);
	}
});

test("direct AST containment and ancestry cycles reject without rejecting normal backlinks", () => {
	const normal = patterns.parse("x/{a,b}/z");
	assert.equal(patterns.stringify(normal), "x/{a,b}/z");
	assert.deepEqual(patterns.expand(normal), ["x/a/z", "x/b/z"]);
	for (const method of ["compile", "stringify", "expand"]) {
		const cyclic = { type: "root", nodes: [] };
		cyclic.nodes.push(cyclic);
		assert.throws(() => patterns[method](cyclic), /containment/);
		const parent = { type: "text", value: "x" };
		parent.parent = parent;
		assert.throws(() => patterns[method]({ type: "root", nodes: [parent] }), /ancestry/);
	}
});

test("Cartesian expansion and disabled numeric range limits cannot bypass the result budget", () => {
	assert.throws(() => patterns.expand("{a,b}".repeat(16)), /budget/);
	assert.throws(() => patterns.expand("{1..1000000}", { rangeLimit: false }), /range limit/);
	assert.deepEqual(patterns.expand("{a,b}{1..3}"), ["a1", "a2", "a3", "b1", "b2", "b3"]);
});

test("range admission precedes allocation for descending, explicit and option-controlled steps", (context) => {
	const upstream = referencePackage(context, "braces");
	// Demonstrate the old positional/sign bugs at a bounded size, never allocate the billion-item witness.
	for (const [pattern, options] of [["{10001..1}", {}], ["{1..20001..2}", {}], ["{1..20001}", { step: -2 }]]) {
		assert.equal(upstream.expand(pattern, options).length, 10001);
		assert.throws(() => patterns.expand(pattern, options), /range limit exceeded before allocation/);
	}
	for (const pattern of ["{1000000000..1}", "{1..1000000000..2}", "{1000000000..1..-2}", "{1..1000000000..0}"])
		assert.throws(() => patterns.expand(pattern, { rangeLimit: false }), /range limit exceeded before allocation/);
	for (const pattern of ["{1..1000000000..2}", "{1000000000..1..-2}"])
		assert.throws(() => patterns.compile(pattern), /range limit exceeded before allocation/);
	assert.throws(() => patterns.compile("{1..1000000000}", { step: -2 }), /range limit exceeded before allocation/);
	for (const method of ["compile", "expand"]) {
		assert.throws(() => patterns[method]("{1..1000000000}", { step: {} }), /range step type/);
		assert.throws(() => patterns[method]("{1..1000000000}", { step: { step: {} } }), /range step type/);
		assert.throws(() => patterns[method]("{9007199254740992..9007199254741000}"), /unsafe range endpoint/);
		assert.throws(() => patterns[method]("{1..2..9007199254740992}"), /unsafe range step/);
	}
	assert.equal(upstream.expand("{1..10001}", { step: {} }).length, 10001);
	for (const [pattern, options] of [["{5..1..-2}", {}], ["{1..5..0}", {}], ["{1..5}", { step: -2 }], ["{z..a..2}", {}]]) {
		assert.deepEqual(patterns.expand(pattern, options), upstream.expand(pattern, options));
		assert.equal(patterns.compile(pattern, options), upstream.compile(pattern, options));
	}
});

test("compact unit-step numeric regexes remain bounded without materializing their cardinality", (context) => {
	const upstream = referencePackage(context, "braces");
	for (const pattern of ["{1..1000000000}", "{1000000000..1}", "{-9007199254740991..9007199254740991}"]) {
		const compiled = patterns.compile(pattern);
		assert.equal(compiled, upstream.compile(pattern));
		assert.ok(compiled.length < 2000);
		const expression = new RegExp(`^${compiled}$`);
		assert.equal(expression.test("1"), true);
		assert.equal(expression.test("outside"), false);
	}
	assert.throws(() => patterns.expand(`{${"0".repeat(2000)}1..9999}`, { rangeLimit: false }), /range limit exceeded before allocation/);
});

test("range work and compilation output share one per-call budget across independent AST nodes", () => {
	assert.throws(() => patterns.compile("{1..20000..2}".repeat(200)), /aggregate range budget exceeded before allocation/);
	assert.throws(() => patterns.expand("{1..1000}".repeat(11)), /budget/);
	const text = "x".repeat(4 * 1024 * 1024 - 1);
	const ast = { type: "root", nodes: [{ type: "text", value: text }, { type: "text", value: text },
		{ type: "text", value: "{", isOpen: true }, { type: "text", value: "{", isOpen: true }] };
	assert.throws(() => patterns.compile(ast, { escapeInvalid: true }), /compilation output budget/);
	assert.equal(patterns.compile("{1..9..2}{11..19..2}"), "(1|3|5|7|9)(11|13|15|17|19)");
	const siblings = { type: "root", nodes: Array.from({ length: 65000 }, () => ({ type: "text", value: "x".repeat(128) })) };
	assert.equal(patterns.compile(siblings), "x".repeat(65000 * 128));
});

function signEnvelope(codec, privateKey, digest, algorithmChildren) {
	const { asn1 } = codec;
	const envelope = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
		asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, algorithmChildren),
		asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, digest),
	]);
	return privateKey.sign(asn1.toDer(envelope).getBytes(), "NONE");
}

test("upstream accepts extra digest children; hardened RSA rejects them and keeps valid signatures", (context) => {
	const upstream = referencePackage(context, "node-forge");
	const keys = upstream.pki.rsa.generateKeyPair(2048);
	const publicKey = certificateCodec.pki.publicKeyFromPem(upstream.pki.publicKeyToPem(keys.publicKey));
	const digest = upstream.md.sha256.create().update("isolated signed control").digest().getBytes();
	const { asn1 } = upstream;
	const oid = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(upstream.oids.sha256).getBytes());
	const nullValue = () => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, "");
	for (const children of [[oid], [oid, nullValue()]]) {
		const signature = signEnvelope(upstream, keys.privateKey, digest, children);
		assert.equal(keys.publicKey.verify(digest, signature), true);
		assert.equal(publicKey.verify(digest, signature), true);
		assert.equal(publicKey.verify("wrong digest", signature), false);
	}
	for (const children of [[oid, nullValue(), nullValue()], [oid, nullValue(), oid],
		[oid, asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, "x")],
		[oid, asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [])],
		[oid, asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, true, [])],
		[oid, asn1.create(asn1.Class.CONTEXT_SPECIFIC, asn1.Type.NULL, false, "")]]) {
		const signature = signEnvelope(upstream, keys.privateKey, digest, children);
		assert.equal(keys.publicKey.verify(digest, signature), true, "original defect must be demonstrated");
		assert.throws(() => publicKey.verify(digest, signature), /DigestInfo/);
	}
});

test("the actual sandbox SDK retains native CA, leaf certificate and secure-context behavior", async () => {
	const generated = generateCa({ cn: "Pi isolated hardening control", validityDays: 2 });
	assert.equal(validateCaPair(generated.certPem, generated.keyPem).ok, true);
	const ca = createMitmCA({ caCertPem: generated.certPem, caKeyPem: generated.keyPem });
	try {
		const leaf = mintLeafCert(ca, "example.invalid");
		const certificate = certificateCodec.pki.certificateFromPem(leaf.certPem);
		assert.equal(generated.cert.verify(certificate), true);
		assert.ok(secureContextFor(ca, "example.invalid"));
		assert.equal(mintLeafCert(ca, "example.invalid"), leaf);
	} finally { await disposeMitmCA(ca); }
});
