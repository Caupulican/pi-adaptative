#!/usr/bin/env node
/**
 * Live acceptance of the owner channel's subscription allowance with a real model and the provider's real usage endpoint.
 *
 * The real session code runs with a fake Telegram Bot API in this process (nothing leaves the machine but the model calls),
 * with tiny dollar bounds ($0.05 per turn, $0.10 per day) and `ownerQuotaMaxUsedPercent` set by `--quota-percent`.
 * The owner sends one multi-step task and `status`. Every verdict is read from what the harness sent to the chat, never from
 * what a model says:
 *  - `--quota-percent 95` and the account reports usage below it: the turn runs past its dollar bound and is answered, nothing
 *    says it reached a bound, and `status` says the dollar bounds do not apply.
 *  - `--quota-percent 0.01` and the account reports any usage: the turn is stopped at its dollar bound with the line naming the
 *    subscription's usage, and `status` says the bounds apply.
 * Exit 0: passed. 1: failed. 3: inconclusive (the provider's usage is unreadable, or sits where the mode cannot be shown, or
 * the network failed): it is neither a pass nor a harness failure. Spends subscription quota; CI never runs it.
 *   node scripts/accept-owner-quota-live.mjs [--quota-percent 95] [--model xai/grok-4.7-build-fast] [--dir <empty dir>]
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	AuthStorage,
	createAgentSession,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "../packages/coding-agent/src/index.ts";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const QUOTA_PERCENT = Number(flag("quota-percent", "95"));
const [PROVIDER, ...MODEL_PARTS] = flag("model", "xai/grok-4.7-build-fast").split("/");
const OWNER_ID = 424242;
const ownDir = flag("dir", undefined) === undefined;
const ROOT = flag("dir", undefined) ?? mkdtempSync(join(tmpdir(), "pi-owner-quota-"));
const AGENT = join(ROOT, "agent");
const PROJECT = join(ROOT, "proj");
mkdirSync(join(AGENT, "channels"), { recursive: true });
mkdirSync(PROJECT, { recursive: true });
writeFileSync(join(PROJECT, "README.md"), "owner live test\n");
writeFileSync(join(PROJECT, "todo.txt"), "one\ntwo\nthree\n");
symlinkSync(join(homedir(), ".pi", "agent", "auth.json"), join(AGENT, "auth.json"));
// A token of the right shape; the Bot API is faked below.
writeFileSync(join(AGENT, "channels", "telegram.token"), `123456789:${"abcdefghijklmnopqrstuvwxyz0123456789".slice(0, 35)}\n`);
chmodSync(join(AGENT, "channels", "telegram.token"), 0o600);

// The fake Telegram Bot API: only getUpdates and sendMessage are used by the shipped transport.
const sent = [];
const updates = [];
let nextUpdate = 1000;
const realFetch = globalThis.fetch;
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	if (!url.startsWith("https://api.telegram.org/bot")) return realFetch(input, init);
	const method = url.slice(url.lastIndexOf("/") + 1);
	const body = init?.body ? JSON.parse(String(init.body)) : {};
	if (method === "sendMessage") {
		sent.push({ chat: body.chat_id, text: String(body.text) });
		return json({ ok: true, result: { message_id: sent.length } });
	}
	if (method === "getUpdates") {
		const offset = typeof body.offset === "number" ? body.offset : 0;
		for (let index = updates.length - 1; index >= 0; index--) if (updates[index].update_id < offset) updates.splice(index, 1);
		const deadline = Date.now() + 2000;
		while (updates.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
		return json({ ok: true, result: updates.map((update) => structuredClone(update)) });
	}
	return json({ ok: true, result: true });
};
const say = (text) =>
	updates.push({
		update_id: nextUpdate++,
		message: {
			message_id: nextUpdate,
			date: Math.floor(Date.now() / 1000),
			chat: { id: OWNER_ID, type: "private" },
			from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
			text,
		},
	});
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const waitFor = async (label, check, ms) => {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
		const value = check();
		if (value) return value;
	}
	throw new Error(`timed out waiting for ${label}`);
};
const finish = (code, message) => {
	console.log(message);
	if (ownDir) rmSync(ROOT, { recursive: true, force: true });
	setTimeout(() => process.exit(code), 500);
};

const authStorage = AuthStorage.create(join(AGENT, "auth.json"));
const modelRegistry = ModelRegistry.create(authStorage);
const model = modelRegistry.find(PROVIDER, MODEL_PARTS.join("/"));
if (!model) {
	console.log(`inconclusive: ${PROVIDER}/${MODEL_PARTS.join("/")} is not available`);
	process.exit(3);
}
const { session } = await createAgentSession({
	cwd: PROJECT,
	agentDir: AGENT,
	model,
	authStorage,
	modelRegistry,
	settingsManager: SettingsManager.inMemory({
		channels: {
			telegram: {
				mode: "explicit",
				ownerSenders: [OWNER_ID],
				replyMode: "draft",
				ownerMaxUsdPerTurn: 0.05,
				ownerMaxUsdPerDay: 0.1,
				ownerQuotaMaxUsedPercent: QUOTA_PERCENT,
			},
		},
		systemOne: { enabled: false },
		advisor: { enabled: false },
		routines: { away: { enabled: false } },
	}),
	sessionManager: SessionManager.create(PROJECT, AGENT),
});
try {
	await sleep(4000); // the channel starts polling
	// The reader answers from a cached reading and refreshes on each read: ask until a reading has landed.
	let allowance = session.ownerChannel.quotaAllowance(QUOTA_PERCENT);
	for (let tries = 0; allowance.kind === "unknown" && tries < 20; tries++) {
		await sleep(2000);
		allowance = session.ownerChannel.quotaAllowance(QUOTA_PERCENT);
	}
	console.log(`allowance for ${QUOTA_PERCENT}%: ${JSON.stringify(allowance)}`);
	const expected = QUOTA_PERCENT >= 50 ? "room" : "exhausted";
	if (allowance.kind === "unknown") finish(3, `inconclusive: the provider's usage is unreadable (${allowance.reason})`);
	else if (allowance.kind !== expected) finish(3, `inconclusive: the account's usage (${allowance.usedPercent}%) cannot show "${expected}" at ${QUOTA_PERCENT}%`);
	else {
		say("Run `ls`, then read README.md and todo.txt with the read tool, then summarize both files in two sentences.");
		await waitFor("a message to the owner", () => sent.length > 0, 240_000);
		await sleep(4000);
		const texts = sent.map((message) => message.text);
		const quotaStop = texts.some((text) => /subscription's usage reached its bound/i.test(text));
		const dollarStop = texts.some((text) => /reached its bound \(channels\.telegram\.ownerMaxUsdPerTurn/i.test(text));
		say("status");
		const statusText = await waitFor("the status reply", () => sent.map((m) => m.text).find((t) => /Owner spend:/.test(t)), 60_000);
		const problems = [];
		if (expected === "room") {
			if (quotaStop || dollarStop) problems.push(`the turn was stopped at a bound despite room: ${texts.join(" | ").slice(0, 200)}`);
			if (texts.length === 0) problems.push("the owner got no answer");
			if (!/the dollar bounds do not apply/.test(statusText)) problems.push(`status does not say the bounds are lifted: ${statusText.slice(0, 200)}`);
		} else {
			if (!quotaStop) problems.push(`the turn was not stopped with the subscription's reason: ${texts.join(" | ").slice(0, 200)}`);
			if (!/the dollar bounds apply/.test(statusText)) problems.push(`status does not say the bounds apply: ${statusText.slice(0, 200)}`);
		}
		const statusLines = statusText.split("\n");
		if (statusLines.some((line) => line.length === 1)) problems.push("status prints single-character lines");
		finish(problems.length === 0 ? 0 : 1, problems.length === 0 ? `passed (${expected} at ${QUOTA_PERCENT}%)` : `failed: ${problems.join("; ")}`);
	}
} catch (error) {
	const text = error instanceof Error ? error.message : String(error);
	finish(/fetch failed|EAI_AGAIN|ECONNRESET|ETIMEDOUT/i.test(text) ? 3 : 1, `${/fetch failed|EAI_AGAIN|ECONNRESET|ETIMEDOUT/i.test(text) ? "inconclusive" : "failed"}: ${text}`);
} finally {
	session.dispose?.();
}
