import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closeLane, type FlowDeps } from "../src/done-flow.ts";
import { launchLane, LaunchError, prepareLaunch } from "../src/launch.ts";
import { parkLane } from "../src/park.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const HOUR = 3_600_000;
const cli = join(import.meta.dir, "../src/cli.ts");
const lane: Lane = {
  key: "ask-lane",
  title: "ask",
  thread: "chat:team/5",
  pane: "w:p1",
  brief: "/briefs/ask.md",
  done: "merged acme/app#1",
  cwd: "/repo",
  openedAt: new Date(T0 - HOUR).toISOString(),
};

let state: ReturnType<typeof withState>;
let world: World;
let brief: string;
const deps = (ms = T0): FlowDeps =>
  depsFor(world, fakeClock(ms), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
const input = (resume?: boolean) => ({
  key: lane.key,
  title: "ask",
  brief,
  done: lane.done,
  ...(resume === undefined ? {} : { resume }),
});
const refusal = async (resume?: boolean): Promise<string> => {
  const error = await prepareLaunch(deps(), input(resume)).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(LaunchError);
  return (error as Error).message;
};

beforeEach(async () => {
  state = withState();
  world = newWorld();
  brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  await deps().registry.write(lane);
});
afterEach(() => state.done());

test("park closes the session of a lane whose Done signal is not live, and keeps its worktree, thread and reports", async () => {
  world.prState = "OPEN";
  const reports = join(state.dir, "lanes", lane.key, "reports.jsonl");
  mkdirSync(join(state.dir, "lanes", lane.key), { recursive: true });
  writeFileSync(reports, '{"type":"report","kind":"question"}\n');

  const r = await parkLane(deps(T0 + HOUR), lane, "waiting for the owner");

  expect(r.parked).toBe(true);
  expect(r.line).toStartWith(
    `PARKED ask-lane {"parked":true,"note":"waiting for the owner","cleanup":["pane w:p1 closed"`,
  );
  const stored = (await deps().registry.read(lane.key)) as Lane;
  expect(statusOf(stored)).toBe("closed");
  expect(stored.closedAt).toBe(new Date(T0 + HOUR).toISOString());
  expect(stored.receipt).toMatchObject({ parked: true, note: "waiting for the owner" });
  expect(world.calls).toContainEqual(["herdr", "pane", "close", "w:p1"]);
  expect(world.calls.filter((c) => c[0] === "gh" || c[0] === "notify" || c.includes("remove"))).toEqual([]);
  expect(readFileSync(reports, "utf8")).toBe('{"type":"report","kind":"question"}\n');
});

test("park refuses a lane that is already closed and leaves its record as it was", async () => {
  const closed: Lane = { ...lane, status: "closed", closedAt: new Date(T0).toISOString(), receipt: { note: "done" } };
  await deps().registry.write(closed);
  const before = await deps().registry.read(lane.key);
  const r = await parkLane(deps(), closed, "later");
  expect(r).toEqual({ parked: false, line: "REFUSED ask-lane: the lane is already closed" });
  expect(await deps().registry.read(lane.key)).toEqual(before);
  expect(world.calls).toEqual([]);
});

test("a parked key is still taken for a plain launch, and --resume starts it again with a fresh open record", async () => {
  await parkLane(deps(), lane, "waiting");
  expect(await refusal()).toBe("lane ask-lane is already registered");

  world = newWorld();
  world.panes = [{ pane_id: "w:p9", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  world.screen = "❯ \n Pursuing goal (1m)";
  const base = deps(T0 + 2 * HOUR);
  const tabCreate = async (argv: readonly string[]) =>
    argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create"
      ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }), err: "" }
      : base.run(argv);
  const r = await launchLane({ ...base, run: tabCreate }, input(true));

  expect(r.startup).toBe("STARTUP_OK ask-lane w:p9");
  const stored = (await deps().registry.read(lane.key)) as Lane;
  expect(statusOf(stored)).toBe("working");
  expect(stored).toMatchObject({ pane: "w:p9", openedAt: new Date(T0 + 2 * HOUR).toISOString() });
  expect(stored.closedAt).toBeUndefined();
  expect(stored.receipt).toBeUndefined();
});

test("--resume refuses a lane that is still open, one closed by close, and an unknown key", async () => {
  expect(await refusal(true)).toBe("lane ask-lane is working, not parked; --resume restarts a parked lane only");
  const r = await closeLane(deps(), lane, "Done");
  expect(r.closed).toBe(true);
  expect(await refusal(true)).toBe("lane ask-lane is closed, not parked; --resume restarts a parked lane only");
  const error = await prepareLaunch(deps(), { ...input(true), key: "new-lane" }).catch((e: unknown) => e);
  expect((error as Error).message).toBe("lane new-lane is not registered; --resume restarts a parked lane only");
});

test("dori park exits 2 on a closed lane, and dori launch --resume --dry-run prints the brief for a parked one", async () => {
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
  const invoke = (...args: string[]) =>
    run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, process.execPath, cli, ...args]);
  const at = new Date(T0).toISOString();
  await deps().registry.write({ ...lane, status: "closed", closedAt: at, receipt: { parked: true } });

  const parked = await invoke("park", lane.key);
  expect({ code: parked.code, out: parked.out.trim() }).toEqual({
    code: 2,
    out: "REFUSED ask-lane: the lane is already closed",
  });
  const common = ["--title", "t", "--brief", brief, "--done", lane.done, "--dry-run"];
  const plain = await invoke("launch", lane.key, ...common);
  expect({ code: plain.code, err: plain.err.trim() }).toEqual({ code: 1, err: "lane ask-lane is already registered" });
  const resumed = await invoke("launch", lane.key, ...common, "--resume");
  expect(resumed.code).toBe(0);
  expect(resumed.out).toContain("# brief");
  expect(statusOf((await deps().registry.read(lane.key)) as Lane)).toBe("closed");
});
