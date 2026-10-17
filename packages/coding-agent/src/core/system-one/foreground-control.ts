/**
 * Shared vocabulary of System One's levers. A steer is either queued for the executor's next model
 * turn or delivered now by interrupting the running one (see `worker-control.ts`, the lever System
 * One holds over workers). System One holds no cancel over the root's own turn.
 */

export type SystemOneSteerDelivery = "queue" | "now";
