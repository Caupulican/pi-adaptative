export type VirtualProcessState = "alive" | "dead" | "denied" | "unknown";

/** The only signals an owned virtual child can receive; anything else is refused and recorded. */
export type VirtualChildSignal = "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";

const CHILD_SIGNALS: ReadonlySet<string> = new Set<VirtualChildSignal>(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]);
const FIRST_CHILD_PID = 50_000;
const MAX_VIRTUAL_PID = 2_147_483_647;
/** Explicit per-world bounds: live owned children, and every child ever registered (live plus known closed). */
const MAX_ACTIVE_CHILDREN = 256;
const MAX_REGISTERED_CHILDREN = 1024;

/** An external actor the harness owns. Delivery requests termination; only {@link VirtualProcessTable.releaseChild} ends it. */
export interface VirtualOwnedChild {
	/** True when the child leads its own process group, so a negative-pid signal reaches it. */
	readonly detached: boolean;
	/** Synchronous acceptance of a delivered signal. It must not report the child dead. */
	deliver(signal: VirtualChildSignal): void;
}

/** External PID/liveness boundary only: never sends host signals or edits native worker attempts. */
export class VirtualProcessTable {
	private currentPid = process.pid;
	private readonly states = new Map<number, VirtualProcessState>([[this.currentPid, "alive"]]);
	/** Live owned children only: the delivery callback is dropped at physical close. */
	private readonly active = new Map<number, VirtualOwnedChild>();
	/** Known closed children as primitives (pid -> detached), so a late native signal still answers ESRCH. */
	private readonly closed = new Map<number, boolean>();
	private nextChildPid = FIRST_CHILD_PID;
	readonly probes: Array<{ readonly pid: number; readonly signal: NodeJS.Signals | number | undefined }> = [];
	/** Signals accepted for an exact owned child or group. Acceptance is never a death claim. */
	readonly delivered: Array<{ readonly pid: number; readonly group: boolean; readonly signal: VirtualChildSignal }> =
		[];
	readonly unscripted: string[] = [];

	get self(): number {
		return this.currentPid;
	}

	setState(pid: number, state: VirtualProcessState): void {
		if (!Number.isSafeInteger(pid) || pid <= 0)
			throw new RangeError("Virtual process pid must be a positive integer");
		if (this.active.has(pid) || this.closed.has(pid))
			throw new Error(`Virtual process ${pid} is owned by a registered child`);
		this.states.set(pid, state);
	}

	/** Call only after old physical actors have settled. Native recovery will observe the dead recorded owner. */
	advanceProcess(): { readonly previousPid: number; readonly pid: number } {
		const live = this.liveChildren();
		if (live.length) throw new Error(`Virtual process advance with live owned children: ${live.join(",")}`);
		const previousPid = this.currentPid;
		this.states.set(previousPid, "dead");
		do {
			this.currentPid++;
		} while (this.states.has(this.currentPid));
		this.states.set(this.currentPid, "alive");
		return { previousPid, pid: this.currentPid };
	}

	isAlive(pid: number): boolean {
		return this.states.get(pid) !== "dead";
	}

	/** Allocate a collision-free positive pid for an owned child. The child is alive until {@link releaseChild}. */
	registerChild(child: VirtualOwnedChild): number {
		if (this.active.size >= MAX_ACTIVE_CHILDREN || this.active.size + this.closed.size >= MAX_REGISTERED_CHILDREN) {
			const detail = `Virtual child registration exceeds its bound (active=${this.active.size}, known=${this.active.size + this.closed.size})`;
			this.unscripted.push(detail);
			throw new RangeError(detail);
		}
		let pid = this.nextChildPid;
		while (this.states.has(pid) || pid === process.ppid || pid === 1) pid++;
		if (pid > MAX_VIRTUAL_PID) throw new RangeError("Virtual child pid space is exhausted");
		this.nextChildPid = pid + 1;
		this.states.set(pid, "alive");
		this.active.set(pid, child);
		return pid;
	}

	/** The child's physical close, once: only now does the table report it dead and drop its delivery callback. */
	releaseChild(pid: number): void {
		const child = this.active.get(pid);
		if (child === undefined) throw new Error(`Virtual process ${pid} is not a live owned child`);
		this.active.delete(pid);
		this.closed.set(pid, child.detached);
		this.states.set(pid, "dead");
	}

	/** Owned children whose physical close has not been released. */
	liveChildren(): number[] {
		return [...this.active.keys()];
	}

	signal(pid: number, signal?: NodeJS.Signals | number): boolean {
		this.probes.push({ pid, signal });
		if (signal !== 0) return this.deliverToOwnedChild(pid, signal);
		const state = this.states.get(pid) ?? "unknown";
		if (state === "alive") return true;
		throw Object.assign(new Error(`Virtual process ${pid} is ${state}`), {
			// Permission denial proves existence; an inconclusive probe must remain genuinely unknown.
			code: state === "dead" ? "ESRCH" : state === "denied" ? "EPERM" : "EIO",
		});
	}

	/** Only an exact owned child or its detached group may be signaled; everything else is refused, never forwarded. */
	private deliverToOwnedChild(pid: number, signal: NodeJS.Signals | number | undefined): boolean {
		const group = pid < 0;
		const id = Math.abs(pid);
		const live = this.active.get(id);
		if (typeof signal !== "string" || !CHILD_SIGNALS.has(signal) || (live === undefined && !this.closed.has(id))) {
			// Unknown or non-owned targets and unsupported signals are fatal refusals, never forwarded to a host.
			this.unscripted.push(`${pid}:${String(signal)}`);
			throw new Error(`Virtual process signaling refused: ${pid}:${String(signal)}`);
		}
		if (live === undefined || (group && !live.detached)) {
			// A closed child, or a group the child does not lead, is genuinely absent.
			throw Object.assign(new Error(`Virtual process ${pid} is not running`), { code: "ESRCH" });
		}
		const delivered = signal as VirtualChildSignal;
		this.delivered.push({ pid: id, group, signal: delivered });
		live.deliver(delivered);
		return true;
	}

	assertClean(): void {
		const failures: string[] = [];
		if (this.unscripted.length) failures.push(`Unscripted process signals: ${this.unscripted.join(",")}`);
		const live = this.liveChildren();
		if (live.length) failures.push(`Owned virtual children still alive: ${live.join(",")}`);
		if (failures.length) throw new Error(failures.join("; "));
	}
}
