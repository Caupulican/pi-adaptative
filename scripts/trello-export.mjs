#!/usr/bin/env node
/**
 * Read-only Trello export for the consult-only bot.
 *
 * Reads the owner's existing Trello connection (a `.env` file with TRELLO_API_KEY and TRELLO_TOKEN) and writes one JSON file per
 * board into `--out`: the board's open lists and their open cards (id, title, labels, description, due date, last activity).
 * The bot reads those files with its own read-only tools, so no credential ever reaches a model, a transcript or a shell. It
 * issues GET requests only and never prints a key, a token or a URL carrying one.
 *
 *   node scripts/trello-export.mjs --out <dir> [--env <file>] [--boards GrimDex,FeedTamer]
 *
 * `--env` defaults to $TRELLO_ENV_FILE, then ~/.pi/agent/trello/.env, then ~/GitHub/mine/CaupulicanDev/integrations/trello/.env.
 * `--boards` keeps the open boards whose name contains one of the words (case-insensitive); omitted, every open board is exported.
 * Exit 0: exported. 2: no credentials or unreadable file. 1: Trello refused or failed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { flag } from "./live-args.mjs";

const OUT = flag("out", undefined);
if (!OUT) {
	console.error("trello-export: --out <dir> is required.");
	process.exit(2);
}
const candidates = [
	flag("env", undefined),
	process.env.TRELLO_ENV_FILE,
	join(homedir(), ".pi", "agent", "trello", ".env"),
	join(homedir(), "GitHub", "mine", "CaupulicanDev", "integrations", "trello", ".env"),
].filter((path) => typeof path === "string" && path.length > 0);
const envFile = candidates.find((path) => existsSync(path));
if (!envFile) {
	console.error(`trello-export: no credential file found (looked for ${candidates.length} locations).`);
	process.exit(2);
}
const values = Object.fromEntries(
	readFileSync(envFile, "utf8")
		.split(/\r?\n/)
		.flatMap((line) => {
			const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
			return match ? [[match[1], match[2].replace(/^(['"])(.*)\1$/, "$2")]] : [];
		}),
);
if (!values.TRELLO_API_KEY || !values.TRELLO_TOKEN) {
	console.error("trello-export: the credential file has no TRELLO_API_KEY and TRELLO_TOKEN.");
	process.exit(2);
}
const authorization = `OAuth oauth_consumer_key="${values.TRELLO_API_KEY}", oauth_token="${values.TRELLO_TOKEN}"`;
const get = async (path, query = {}) => {
	const url = new URL(`https://api.trello.com/1${path}`);
	for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
	const response = await fetch(url, { method: "GET", headers: { Authorization: authorization, Accept: "application/json" } });
	if (!response.ok) throw new Error(`Trello answered HTTP ${response.status} for GET ${path}`);
	return response.json();
};
const words = (flag("boards", "") ?? "")
	.split(",")
	.map((word) => word.trim().toLowerCase())
	.filter(Boolean);
try {
	const boards = (await get("/members/me/boards", { fields: "name,closed", filter: "open" })).filter(
		(board) => words.length === 0 || words.some((word) => board.name.toLowerCase().includes(word)),
	);
	mkdirSync(resolve(OUT), { recursive: true });
	for (const board of boards) {
		const lists = await get(`/boards/${board.id}/lists`, { filter: "open", fields: "name" });
		const cards = await get(`/boards/${board.id}/cards`, {
			filter: "open",
			fields: "name,desc,idList,due,dateLastActivity,labels",
		});
		const exported = {
			board: board.name,
			exportedAt: new Date().toISOString(),
			lists: lists.map((list) => ({
				name: list.name,
				cards: cards
					.filter((card) => card.idList === list.id)
					.map((card) => ({
						id: card.id,
						title: card.name,
						labels: (card.labels ?? []).map((label) => label.name || label.color).filter(Boolean),
						desc: String(card.desc ?? "").slice(0, 1200),
						...(card.due ? { due: card.due } : {}),
						lastActivity: card.dateLastActivity,
					})),
			})),
		};
		const file = join(resolve(OUT), `${board.name.replace(/[^A-Za-z0-9_-]+/g, "-").toLowerCase()}.json`);
		writeFileSync(file, `${JSON.stringify(exported, null, 1)}\n`);
		console.log(`${board.name}: ${lists.length} list(s), ${cards.length} open card(s) -> ${file}`);
	}
	if (boards.length === 0) console.log("no open board matched.");
} catch (error) {
	console.error(`trello-export: ${error instanceof Error ? error.message.replace(/oauth_[a-z_]+="[^"]*"/gi, "[credential]") : "failed"}`);
	process.exit(1);
}
