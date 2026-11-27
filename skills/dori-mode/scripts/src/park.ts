import { AGENT_SESSION_KINDS } from "../../../../src/runtime/types.ts";
import { closeSession, endSession, type FlowDeps } from "./done-flow.ts";
import { type Lane, LANE_KEY, type Registry, RESERVED_LANE_KEY, sessionOf, statusOf, withStatus } from "./registry.ts";
import { iso } from "./run.ts";

/**
 * A parked lane only waits for an answer from the owner: its session is closed to free the host, and its record is kept
 * (closed, `receipt.parked`) so `dori launch <key> --resume` can start the same key again. Parking reads no Done signal
 * and leaves the thread, the worktrees and everything under the state dir (reports, checkpoints, evidence) as they are.
 */
export const parkLane = async (
  deps: FlowDeps,
  lane: Lane,
  note: string,
): Promise<{ readonly parked: boolean; readonly line: string }> => {
  if (statusOf(lane) === "closed") return { parked: false, line: `REFUSED ${lane.key}: the lane is already closed` };
  const ref = sessionOf(lane);
  const cleanup = ref ? await endSession(deps, ref) : [];
  const at = iso(deps.clock);
  const receipt = { parked: true, note, cleanup };
  await deps.registry.write(withStatus(lane, "closed", note, at, { closedAt: at, receipt }));
  // As in closeLane: a read between the close and the write may have resumed a host session, so close it once more.
  if (ref && AGENT_SESSION_KINDS.has(ref.runtime)) await closeSession(deps, ref);
  return { parked: true, line: `PARKED ${lane.key} ${JSON.stringify(receipt)}` };
};

const isParked = (lane: Lane): boolean =>
  statusOf(lane) === "closed" &&
  typeof lane.receipt === "object" &&
  lane.receipt !== null &&
  (lane.receipt as { parked?: unknown }).parked === true;

/** Why `launch` cannot take `key`; with `resume` only a parked lane's record is accepted (and replaced). */
export const launchRefusal = async (registry: Registry, key: string, resume = false): Promise<string | undefined> => {
  if (!LANE_KEY.test(key)) return `key must match ${LANE_KEY}`;
  if (key === RESERVED_LANE_KEY) return `lane key "${RESERVED_LANE_KEY}" is reserved for the lead`;
  const existing = await registry.read(key);
  if (!resume) return existing ? `lane ${key} is already registered` : undefined;
  if (!existing) return `lane ${key} is not registered; --resume restarts a parked lane only`;
  return isParked(existing)
    ? undefined
    : `lane ${key} is ${statusOf(existing)}, not parked; --resume restarts a parked lane only`;
};
