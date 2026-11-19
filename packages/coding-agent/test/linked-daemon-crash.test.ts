/** Local process-loss check. The paired executor stays alive while the coordinator CLI is killed and replaced. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { configFile } from "../src/core/agent-paths.ts";
import { botDaemonCommandArgs } from "../src/core/delegation/bot-daemon-command.ts";
import { claimBotDaemonLease } from "../src/core/delegation/bot-daemon-launch.ts";
import { DAEMON_STALE_MS } from "../src/core/delegation/bot-team-routine-helpers.ts";
import { PersistentBotTeamStore } from "../src/core/delegation/persistent-bot-team-store.ts";
import { remoteJobLaneId } from "../src/core/remote/abandoned-placements.ts";
import { linkHostOwner } from "../src/core/remote/host-lock.ts";
import { RemoteHubController } from "../src/core/remote/hub-controller.ts";
import { digestOffer, digestOutcome, type JobOffer, type JobOutcome } from "../src/core/remote/job-protocol.ts";
import { JobStore, publishRunner } from "../src/core/remote/job-store.ts";
import { JobTransport } from "../src/core/remote/job-transport.ts";
import { LinkClient } from "../src/core/remote/link-client.ts";
import { enrollJoin, renameIdentity } from "../src/core/remote/registry.ts";
import { SYSTEM_TIMER_SOURCE } from "../src/core/util/timer-port.ts";

const poll = { interval: 50, timeout: 30_000 };
const leaseTimeout = DAEMON_STALE_MS + 5_000;
// The surviving client's reconnect backoff can reach one minute while the old lease expires.
const replayTimeout = 75_000;

function launchCoordinator(agentDir: string, token: string) {
	const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
	const child = spawn(process.execPath, ["--conditions=pi-source", cli, ...botDaemonCommandArgs(agentDir, token)], {
		cwd: agentDir,
		env: {
			HOME: agentDir,
			USERPROFILE: agentDir,
			PATH: dirname(process.execPath),
			SystemRoot: process.env.SystemRoot,
			TEMP: agentDir,
			TMP: agentDir,
			TMPDIR: agentDir,
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	let diagnostic = "";
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		diagnostic = (diagnostic + chunk).slice(-4096);
	});
	const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
		child.once("error", (error) => resolve({ code: null, signal: null, error }));
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	return {
		child,
		closed,
		async listening() {
			await Promise.race([
				expect.poll(() => linkHostOwner(agentDir), poll).toMatchObject({ pid: child.pid, away: true }),
				closed.then(({ error, code, signal }) => {
					throw error ?? new Error(`Daemon exited before listening (${signal ?? code}): ${diagnostic}`);
				}),
			]);
		},
	};
}

it(
	"a killed coordinator recovers an executor's unacknowledged outcome over the saved link",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-linked-crash-"));
		const hubDir = join(dir, "hub");
		const peerDir = join(dir, "peer");
		const children: ReturnType<typeof launchCoordinator>[] = [];
		const killCoordinators = () => {
			for (const { child } of children) {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}
		};
		// The Vitest parent-disconnect guard calls process.exit(), which skips async finally blocks.
		const onWorkerExit = () => {
			killCoordinators();
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// A terminating process may still hold files open.
			}
		};
		process.once("exit", onWorkerExit);
		let bootstrap: RemoteHubController | undefined;
		let store: PersistentBotTeamStore | undefined;
		let client: LinkClient | undefined;
		let transport: JobTransport | undefined;
		try {
			await mkdir(hubDir);
			await writeFile(
				configFile(hubDir, "settings.json"),
				JSON.stringify({ routines: { away: { enabled: true, autostart: "off" } } }),
			);
			const hub = renameIdentity(hubDir, "crash-hub");
			const peer = renameIdentity(peerDir, "crash-peer");
			const botStore = new PersistentBotTeamStore(hubDir);
			store = botStore;
			bootstrap = new RemoteHubController({ agentDir: hubDir, getStore: () => botStore });
			const port = await bootstrap.listen("127.0.0.1", 0);
			const invitation = bootstrap.add(peer.name);
			const enrolled = enrollJoin(peerDir, `127.0.0.1:${port}`, invitation.token);
			if (!enrolled) throw new Error("Peer could not enroll");
			await bootstrap.stop();
			bootstrap = undefined;

			const start = async () => {
				const claim = claimBotDaemonLease(botStore, SYSTEM_TIMER_SOURCE.port("routines"));
				if (!claim.claimed) throw new Error("The old daemon still owns its lease");
				const run = launchCoordinator(hubDir, claim.token);
				children.push(run);
				await run.listening();
				return run;
			};
			const first = await start();
			const executor = new JobTransport({ agentDir: peerDir, selfId: peer.machineId });
			transport = executor;
			publishRunner(peerDir, [{ provider: "fixture", modelClass: "worker", access: "api", headroom: "unknown" }], 1);
			let hold = true;
			let offered = 0;
			let connected = 0;
			let withheld = false;
			client = new LinkClient({
				identity: peer,
				join: enrolled,
				requireSealed: () => true,
				events: { state() {}, message() {} },
				peers: {
					up(link) {
						connected++;
						executor.up({
							...link,
							send(frame) {
								if (hold && frame.t === "job.outcome") {
									withheld = true;
									return false;
								}
								return link.send(frame);
							},
						});
					},
					down: (id) => executor.down(id),
					receive(id, frame) {
						if (frame.t === "job.offer") offered++;
						executor.receive(id, frame);
					},
				},
			});
			client.start();

			const placed = new JobStore(hubDir);
			const executed = new JobStore(peerDir);
			const jobId = randomUUID();
			const offer: JobOffer = {
				v: 1,
				jobId,
				kind: "task",
				label: "Crash recovery",
				instructions: "Return the fixture result.",
				envelope: { writes: false },
				hops: [hub.machineId],
				deadlineMs: 180_000,
			};
			const now = Date.now();
			placed.createPlaced({
				v: 1,
				jobId,
				executorId: peer.machineId,
				executorName: peer.name,
				ownerSession: randomUUID(),
				laneId: remoteJobLaneId(jobId),
				offer,
				offerDigest: digestOffer(offer),
				createdAt: now,
				deadlineAt: now + offer.deadlineMs,
				state: "pending",
				lastSeq: 0,
			});
			await expect.poll(() => placed.out.list()[0]?.state, poll).toBe("accepted");
			const outcome: JobOutcome = {
				status: "succeeded",
				summary: "The fixture result survived the coordinator crash.",
			};
			const completed = executed.appendOutbox(
				hub.machineId,
				jobId,
				(seq) => ({ t: "job.outcome", seq, jobId, outcome }),
				"terminal",
			);
			if (!completed) throw new Error("Executor did not persist the outcome");
			expect(completed.state).toBe("terminal");
			expect(completed.seq).toBeGreaterThan(completed.ackedSeq);
			await expect.poll(() => withheld, poll).toBe(true);
			expect(executed.in.list()[0]?.outbox).toHaveLength(1);
			expect(placed.out.list()[0]?.outcome).toBeUndefined();

			expect(first.child.kill("SIGKILL")).toBe(true);
			expect(await first.closed).toMatchObject({ signal: "SIGKILL", code: null });
			expect(placed.out.list()[0]?.outcome).toBeUndefined();
			await expect
				.poll(() => botStore.getDaemonStatus(Date.now()).running, { ...poll, timeout: leaseTimeout })
				.toBe(false);
			hold = false;
			await start();

			await expect
				.poll(() => executed.in.list(), { ...poll, timeout: replayTimeout })
				.toMatchObject([{ jobId, state: "terminal", ackedSeq: completed.seq, outbox: [] }]);
			expect(placed.out.list()).toMatchObject([
				{ jobId, state: "terminal", outcome, outcomeDigest: digestOutcome(outcome) },
			]);
			expect(connected).toBeGreaterThanOrEqual(2);
			expect(offered).toBe(1);
		} finally {
			client?.stop();
			transport?.dispose();
			killCoordinators();
			await Promise.all(children.map((run) => run.closed));
			try {
				await bootstrap?.stop();
			} finally {
				store?.dispose();
				await rm(dir, { recursive: true, force: true });
				process.off("exit", onWorkerExit);
			}
		}
	},
	4 * poll.timeout + leaseTimeout + replayTimeout + 10_000,
);
