// A host session has no screen. `read` renders its transcript tail as the lines a TUI pane would show, so the parsers
// that read a lane's screen (launch's startup checks, the freshness sweep, supervision, pause) work unchanged: the
// agent's text and tool output as printed, `Error: ...` for a failed turn, and a footer drawn from the live state.
import { rec, str } from "./exec.ts";

/** Lines of one tool result kept, as a pane keeps a tool's output collapsed to its first rows. */
const RESULT_LINES = 12;
const ARGS_CHARS = 160;

const lines = (text: string): string[] => text.replace(/\s+$/, "").split("\n");

const textOf = (part: Record<string, unknown>): string | undefined =>
  part["type"] === "text" ? str(part["text"]) : undefined;

const partsOf = (content: unknown): Record<string, unknown>[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content.map(rec) : [];

const callLine = (part: Record<string, unknown>): string => {
  const args = rec(part["arguments"]);
  const shown = str(args["command"]) ?? str(args["code"]) ?? JSON.stringify(args);
  return `• ${str(part["name"]) ?? "tool"} ${lines(shown)[0]?.slice(0, ARGS_CHARS) ?? ""}`.trimEnd();
};

function messageLines(message: Record<string, unknown>): string[] {
  const parts = partsOf(message["content"]);
  const role = message["role"];
  if (role === "user") return parts.flatMap((p) => lines(textOf(p) ?? "").map((l) => `> ${l}`));
  if (role === "toolResult") {
    const mark = message["isError"] === true ? "  ✗ " : "  ";
    return parts.flatMap((p) => lines(textOf(p) ?? "").slice(0, RESULT_LINES)).map((l) => `${mark}${l}`);
  }
  if (role !== "assistant") return [];
  const out = parts.flatMap((p) => (p["type"] === "toolCall" ? [callLine(p)] : lines(textOf(p) ?? "")));
  const error = str(message["errorMessage"]);
  return error === undefined ? out : [...out, ...lines(`Error: ${error}`)];
}

/** The transcript entries (`read --tail` order, oldest first) as screen lines; entries that are not messages draw nothing. */
export const renderEntries = (entries: readonly unknown[]): string[] =>
  entries.flatMap((entry) => {
    const e = rec(entry);
    return e["type"] === "message" ? messageLines(rec(e["message"])) : [];
  });

const elapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const [h, m] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60)];
  return `${h ? `${h}h ` : ""}${h || m ? `${m}m ` : ""}${s % 60}s`;
};

/** A question the agent asked (`? <title> [option / option]`): it waits for the answer as its next prompt. */
const questionLines = (state: Record<string, unknown>): string[] =>
  [state["pendingQuestions"], state["pendingDialogs"]].flatMap((list) =>
    (Array.isArray(list) ? list.map(rec) : []).map((q) => {
      const options = Array.isArray(q["options"]) ? q["options"].filter((o) => typeof o === "string") : [];
      const title = str(q["title"]) ?? str(q["question"]) ?? "(question)";
      return `? ${lines(title)[0]}${options.length ? ` [${options.join(" / ")}]` : ""}`;
    }),
  );

/**
 * What a pane's footer shows: any open question, then `Working (<time in this state>)` while a turn runs (supervision
 * reads the duration), the bare idle prompt `❯` otherwise (the freshness sweep's idle check), then the goal as omo's
 * footer names it.
 */
export function footerLines(state: Record<string, unknown>, goal: string, now: number): string[] {
  const since = Date.parse(str(rec(state["lifecycle"])["since"]) ?? "");
  const working = state["isStreaming"] === true || state["isCompacting"] === true;
  const status = working ? `Working (${elapsed(Number.isNaN(since) ? 0 : now - since)})` : "❯";
  const goalLine = goal === "active" ? "Pursuing goal" : goal === "none" ? [] : `Goal ${goal}`;
  return [...questionLines(state), status, ...(Array.isArray(goalLine) ? goalLine : [goalLine])];
}
