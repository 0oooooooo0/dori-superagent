import type { Exec } from "../exec.ts";
import { spawnExec } from "../exec.ts";
import type {
  AgentIdentity,
  CloseScope,
  CreateSpec,
  DeliverOptions,
  DeliverOutcome,
  Key,
  Probe,
  SessionInfo,
  SessionRef,
  SessionRuntime,
  SubmitResult,
} from "../types.ts";
import { asText, hostCall, isReason, OMO, str } from "./exec.ts";
import { footerLines, renderEntries } from "./render.ts";
import { close, create, goalOf, list, probeOf, selfRef, stateOf } from "./sessions.ts";

export type OmoHostRuntimeOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
};

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Lanes as sessions of omo's shared engine host, one `omo host session <verb> --json` call per step (the CLI already
 * attaches, resumes parked sessions and classifies refusals; the raw RPC socket would add auth and attach handling for
 * nothing the CLI lacks). Sessions are agents, not shells: see AGENT_SESSION_KINDS.
 */
export class OmoHostRuntime implements SessionRuntime {
  readonly kind = "omo-host";
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(
    private readonly exec: Exec = spawnExec,
    options: OmoHostRuntimeOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.log = options.log ?? ((line) => void process.stderr.write(`${line}\n`));
    this.now = options.now ?? Date.now;
  }

  self(): SessionRef | undefined {
    return selfRef(this.env);
  }

  /** The host has no workspaces: a group is only the middle part of the session name. */
  async createGroup(label: string, _cwd: string): Promise<string> {
    return label;
  }

  create(spec: CreateSpec): Promise<SessionRef> {
    return create(this.exec, spec);
  }

  /** The agent's first prompt (`command` is prompt text here, never a shell command). */
  async start(ref: SessionRef, command: string): Promise<void> {
    await hostCall(this.exec, ["prompt", ref.id, asText(command)], { redact: asText(command) });
  }

  list(filter?: { readonly group?: string }): Promise<readonly SessionInfo[]> {
    return list(this.exec, filter?.group);
  }

  /** `state`, which resumes a parked session (callers probe only open lanes); a session the host never had is `gone`. */
  async probe(ref: SessionRef): Promise<Probe> {
    return probeOf(await stateOf(this.exec, ref.id));
  }

  /**
   * The last `lines` lines of the rendered transcript plus the live footer; `unwrapped` changes nothing (no wrapping).
   * A session the host does not list reads as an empty screen: `state` and `read` would resume it, and the host resumes
   * a closed session exactly like a parked one, so a screen read must never bring back a lane Dori closed.
   */
  async read(ref: SessionRef, lines: number): Promise<string> {
    if (!(await list(this.exec, undefined)).some((s) => s.ref.id === ref.id)) return "";
    const state = await stateOf(this.exec, ref.id);
    if (state === undefined) return "";
    const tail = await hostCall(this.exec, ["read", ref.id, "--tail", String(Math.min(lines * 2, 400))]);
    const entries = Array.isArray(tail["entries"]) ? tail["entries"] : [];
    const shown = [...renderEntries(entries).slice(-lines), ...footerLines(state, goalOf(state), this.now())];
    return shown.slice(-lines).join("\n");
  }

  /**
   * `prompt` into an idle session (it starts a turn), `steer` into a working one (queued into the running turn); the
   * host refuses a prompt while a turn runs (`busy`), which is the compare-and-send gate. A steer that reaches a session
   * whose turn ended in between is parked until its next prompt: `ambiguous`, never sent again. `force` changes nothing:
   * nothing here is ever blocked (an open question is answered by the next prompt).
   */
  async deliver(ref: SessionRef, text: string, opts: DeliverOptions = {}): Promise<DeliverOutcome> {
    const { when = "idle" } = opts;
    let before: Probe;
    try {
      before = await this.probe(ref);
    } catch (e) {
      this.log(`dori: omo host session state ${ref.id} failed (${messageOf(e)}); holding delivery`);
      return { kind: "not-ready", status: "unknown" };
    }
    if (before.status === "gone") return { kind: "no-agent" };
    const working = before.status === "working";
    if ((when === "idle" && working) || (when === "working" && !working))
      return { kind: "not-ready", status: before.status };
    const sent = asText(text);
    try {
      if (!working) {
        try {
          const r = await hostCall(this.exec, ["prompt", ref.id, sent], { redact: sent });
          return { kind: "delivered", started: r["disposition"] === "started" };
        } catch (e) {
          if (!isReason(e, "busy") || when !== "any") throw e;
        }
      }
      const r = await hostCall(this.exec, ["steer", ref.id, sent], { redact: sent });
      if (r["streaming"] === false)
        return {
          kind: "ambiguous",
          detail: "the turn ended before the steer arrived; it is parked until the session's next prompt",
          failure: "steer parked",
        };
      return { kind: "delivered", started: false };
    } catch (e) {
      if (isReason(e, "busy")) return { kind: "not-ready", status: "working" };
      if (isReason(e, "unknown_session")) return { kind: "no-agent" };
      const detail = messageOf(e).replaceAll(sent, "<text>");
      return { kind: "ambiguous", detail, failure: new Error(detail) };
    }
  }

  /** Always `changed`: a prompt or steer is submitted whole, so no typed text ever waits for an Enter. */
  async submitTyped(_ref: SessionRef, _into: AgentIdentity): Promise<SubmitResult> {
    return "changed";
  }

  async typeIntoShell(_ref: SessionRef, _text: string): Promise<boolean> {
    return false;
  }

  /** Escape is `abort` (stops the running turn; a no-op when idle). Enter has nothing to submit. */
  async keys(ref: SessionRef, names: readonly Key[]): Promise<void> {
    if (names.includes("escape")) await hostCall(this.exec, ["abort", ref.id]);
  }

  /** A host session has no container: both scopes close the session. */
  close(ref: SessionRef, _scope?: CloseScope): Promise<void> {
    return close(this.exec, ref.id);
  }

  /** The argv of a TUI client attached to the session (`omo --attach unix://<socket> --session <id>`), to watch it. */
  async attachArgv(ref: SessionRef): Promise<string[]> {
    const socket = str((await hostCall(this.exec, ["list"]))["socket"]);
    if (socket === undefined) throw new Error("omo host session list named no socket");
    return [OMO, "--attach", `unix://${socket}`, "--session", ref.id];
  }
}
