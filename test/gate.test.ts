import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { mergeGate, review } from "../src/gate.ts";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";

describe("review + merge gate", () => {
  const head = "a".repeat(40);
  function gh(w: World, checks: unknown[]) {
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head }) };
      if (argv[1] === "checks") return { code: 0, stdout: JSON.stringify(checks) };
      if (argv[1] === "merge") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    };
  }

  test("merge is refused without a receipt, with an empty check list, with red checks; allowed at CLEAR + green", async () => {
    const { w, d } = setup();
    gh(w, []);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("no review receipt");
    w.reviewer = () => ({ code: 0, stdout: "HIGH src/a.ts:3 ...\nVERDICT: BLOCK" });
    expect((await review(d, "o/r#7")).verdict).toBe("BLOCK");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("is BLOCK");
    w.reviewer = () => ({ code: 0, stdout: "no findings\nVERDICT: CLEAR" });
    await review(d, "o/r#7", "some/model");
    expect(d.store.receipt("o/r#7", head)!.model).toBe("some/model");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("never green");
    gh(w, [
      { name: "test", bucket: "fail" },
      { name: "lint", bucket: "pass" },
    ]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("test=fail");
    gh(w, [{ name: "test", bucket: "skipping" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("every check was skipped");
    gh(w, [
      { name: "test", bucket: "pass" },
      { name: "docs", bucket: "skipping" },
    ]);
    expect(await mergeGate(d, "o/r#7")).toBe(`MERGED o/r#7 head=${head}`);
    expect(w.calls.at(-1)!.argv).toContain("--match-head-commit");
    expect(
      w.usage.filter((e) => e.name === "dori.merge_decided").map((e) => (e as { outcome: string }).outcome),
    ).toEqual(["no_receipt", "review_block", "no_checks", "checks_red", "checks_all_skipped", "merged"]);
    expect(w.usage.filter((e) => e.name === "dori.review_completed")).toHaveLength(2);
  });

  test("legacy plain lines and whole-line emphasis are accepted", async () => {
    const { w, d } = setup();
    gh(w, []);
    const accepted = [
      ["plain", "no findings\nVERDICT: CLEAR", "CLEAR"],
      ["legacy rationale", "VERDICT: CLEAR — 4 LOW findings", "CLEAR"],
      ["legacy parenthetical", "VERDICT: BLOCK   (at least one HIGH finding)", "BLOCK"],
      ["bold", "**VERDICT: CLEAR**", "CLEAR"],
      ["backticks", "`VERDICT: CLEAR`", "CLEAR"],
      ["spaced emphasis", "** VERDICT: CLEAR **", "CLEAR"],
      ["bold keyword", "**VERDICT**: CLEAR", "CLEAR"],
      ["nested emphasis", "**_VERDICT: CLEAR_**", "CLEAR"],
      ["bold backticks", "**`VERDICT: CLEAR`**", "CLEAR"],
      ["fenced example then real", "```\nVERDICT: BLOCK\n```\n\n**VERDICT: CLEAR**", "CLEAR"],
    ] as const;
    for (const [i, [name, stdout, want]] of accepted.entries()) {
      w.reviewer = () => ({ code: 0, stdout });
      const pr = `o/r#${20 + i}`;
      expect({ name, verdict: (await review(d, pr)).verdict }).toEqual({ name, verdict: want });
      expect(d.store.receipt(pr, head)?.verdict).toBe(want);
    }
  });

  test("markers, indentation, trailing prose and prose mentions never decide", async () => {
    const { w, d } = setup();
    gh(w, []);
    const refused = [
      ["bullet", "- **VERDICT: BLOCK**"],
      ["asterisk bullet", "* **VERDICT: CLEAR**"],
      ["blockquote", "> VERDICT: CLEAR"],
      ["ordered list", "1. VERDICT: CLEAR"],
      ["indented", "  VERDICT: CLEAR"],
      ["indented code block", "    VERDICT: CLEAR"],
      ["bold with trailing sentence", "**VERDICT: CLEAR** — no HIGH or MEDIUM findings"],
      ["em-dash prose behind a bullet", "Findings:\n- VERDICT: CLEAR — is required before merging\n- another note"],
      ["prose mention", "I cannot give a VERDICT: CLEAR without a diff."],
      ["heading", "### VERDICT: CLEAR"],
      ["unclosed fence", "```\nsome code\nVERDICT: BLOCK"],
      ["word continues", "VERDICT: CLEARLY"],
      ["hyphen continues", "VERDICT: CLEAR-ISH"],
    ] as const;
    for (const [i, [name, stdout]] of refused.entries()) {
      w.reviewer = () => ({ code: 0, stdout });
      const pr = `o/r#${40 + i}`;
      const failure: unknown = await review(d, pr).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect({ name, error: failure instanceof Error ? failure.message : "" }).toEqual({
        name,
        error: expect.stringContaining("no VERDICT line"),
      });
      expect(d.store.receipt(pr, head)).toBeUndefined();
    }
  });

  test("plain lines keep last-match; a plain/decorated conflict and a nonzero exit never write a receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 0, stdout: "Example:\nVERDICT: BLOCK\n\nVERDICT: CLEAR" });
    expect((await review(d, "o/r#50")).verdict).toBe("CLEAR");
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: BLOCK\nVERDICT:CLEAR" });
    expect((await review(d, "o/r#53")).verdict).toBe("CLEAR");
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: BLOCK\n  VERDICT: CLEAR" });
    expect((await review(d, "o/r#54")).verdict).toBe("BLOCK");
    w.reviewer = () => ({
      code: 0,
      stdout: "HIGH a.ts:1\nVERDICT: BLOCK\n\nExample of the required line:\n\n    VERDICT: CLEAR",
    });
    expect((await review(d, "o/r#55")).verdict).toBe("BLOCK");
    w.reviewer = () => ({ code: 0, stdout: "HIGH src/a.ts:3 no test\nVERDICT: BLOCK\n\n**VERDICT: CLEAR**" });
    const conflict: unknown = await review(d, "o/r#51").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(conflict instanceof Error ? conflict.message : "").toContain("conflicting verdicts (BLOCK and CLEAR)");
    expect(d.store.receipt("o/r#51", head)).toBeUndefined();
    w.reviewer = () => ({ code: 0, stdout: "**VERDICT: CLEAR**\n\n**VERDICT: BLOCK**" });
    const emphasisedConflict: unknown = await review(d, "o/r#56").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(emphasisedConflict instanceof Error ? emphasisedConflict.message : "").toContain(
      "conflicting verdicts (CLEAR and BLOCK)",
    );
    expect(d.store.receipt("o/r#56", head)).toBeUndefined();
    w.reviewer = () => ({ code: 0, stdout: "````\n```\nVERDICT: CLEAR\n```\n````\n\nVERDICT: BLOCK" });
    expect((await review(d, "o/r#57")).verdict).toBe("BLOCK");
    w.reviewer = () => ({ code: 9, stdout: "**VERDICT: CLEAR**" });
    const failure: unknown = await review(d, "o/r#52").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure instanceof Error ? failure.message : "").toContain("reviewer exited 9");
    expect(d.store.receipt("o/r#52", head)).toBeUndefined();
    const files = readdirSync(join(d.store.root, "receipts")).filter(
      (n) => n.endsWith(".noverdict.txt") && n.startsWith("o__r_52@"),
    );
    expect(files).toHaveLength(1);
    expect(readFileSync(join(d.store.root, "receipts", files[0]!), "utf8")).toBe("**VERDICT: CLEAR**");
  });

  test("the shipped review prompt's template never parses as a verdict", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({
      code: 0,
      stdout: readFileSync(join(import.meta.dir, "..", "prompts", "review.md"), "utf8"),
    });
    await expect(review(d, "o/r#60")).rejects.toThrow("no VERDICT line");
    expect(d.store.receipt("o/r#60", head)).toBeUndefined();
  });

  test("exit 0 without a VERDICT line: bounded stdout tail kept privately, no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    const lines = Array.from({ length: 205 }, (_, i) => `line-${i + 1}`);
    w.reviewer = () => ({ code: 0, stdout: lines.join("\n") });
    const failure: unknown = await review(d, "o/r#8").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    const files = readdirSync(join(d.store.root, "receipts")).filter((n) => n.endsWith(".noverdict.txt"));
    expect(files).toHaveLength(1);
    const name = files[0];
    if (!name || !(failure instanceof Error)) throw new Error("missing diagnostic file or review error");
    expect(name).toStartWith(`o__r_8@${head}`);
    const diagnostic = join(d.store.root, "receipts", name);
    expect(failure.message).toContain("no VERDICT");
    expect(failure.message).toContain(diagnostic);
    expect(statSync(diagnostic).mode & 0o777).toBe(0o600);
    expect(readFileSync(diagnostic, "utf8").split("\n")).toEqual(lines.slice(5));
    expect(d.store.receipt("o/r#8", head)).toBeUndefined();
  });

  test("nonzero exit without a VERDICT line: stdout tail kept too, exit code in the error, no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 9, stdout: "partial reviewer output" });
    const failure: unknown = await review(d, "o/r#9").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    const files = readdirSync(join(d.store.root, "receipts")).filter((n) => n.endsWith(".noverdict.txt"));
    expect(files).toHaveLength(1);
    const name = files[0];
    if (!name || !(failure instanceof Error)) throw new Error("missing diagnostic file or review error");
    const diagnostic = join(d.store.root, "receipts", name);
    expect(failure.message).toContain("reviewer exited 9");
    expect(failure.message).toContain(diagnostic);
    expect(readFileSync(diagnostic, "utf8")).toBe("partial reviewer output");
    expect(statSync(diagnostic).mode & 0o777).toBe(0o600);
    expect(d.store.receipt("o/r#9", head)).toBeUndefined();
  });

  test("a failed re-review at the same head invalidates the earlier CLEAR receipt and refuses merge", async () => {
    const { w, d } = setup();
    gh(w, [{ name: "test", bucket: "pass" }]);
    w.reviewer = () => ({ code: 0, stdout: "no findings\nVERDICT: CLEAR" });
    await review(d, "o/r#70");
    expect(await mergeGate(d, "o/r#70", { dryRun: true })).toBe(`MERGE_OK o/r#70 head=${head} (dry run)`);

    w.reviewer = () => ({ code: 0, stdout: "reviewer output without a verdict" });
    await expect(review(d, "o/r#70")).rejects.toThrow("no VERDICT");
    expect(d.store.receipt("o/r#70", head)).toBeUndefined();
    await expect(mergeGate(d, "o/r#70")).rejects.toThrow("no review receipt");
    // The failed run's diagnostic is kept beside the receipt it invalidated.
    const diagnostics = readdirSync(join(d.store.root, "receipts")).filter((n) => n.endsWith(".noverdict.txt"));
    expect(diagnostics).toHaveLength(1);
    expect(readFileSync(join(d.store.root, "receipts", diagnostics[0]!), "utf8")).toBe(
      "reviewer output without a verdict",
    );

    // A reviewer that exits non-zero cannot leave its own verdict, or an earlier one, behind.
    w.reviewer = () => ({ code: 3, stdout: "no findings\nVERDICT: CLEAR", stderr: "model overloaded" });
    await expect(review(d, "o/r#70")).rejects.toThrow("reviewer exited 3");
    expect(d.store.receipt("o/r#70", head)).toBeUndefined();
    await expect(mergeGate(d, "o/r#70")).rejects.toThrow("no review receipt");

    // A newer CLEAR at the same head restores eligibility.
    w.reviewer = () => ({ code: 0, stdout: "no findings\nVERDICT: CLEAR" });
    expect((await review(d, "o/r#70")).verdict).toBe("CLEAR");
    expect(await mergeGate(d, "o/r#70")).toBe(`MERGED o/r#70 head=${head}`);
  });

  test("a BLOCK re-review at the same head replaces the CLEAR receipt and refuses merge", async () => {
    const { w, d } = setup();
    gh(w, [{ name: "test", bucket: "pass" }]);
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await review(d, "o/r#71");

    w.reviewer = () => ({ code: 0, stdout: "HIGH src/a.ts:3\nVERDICT: BLOCK" });
    expect((await review(d, "o/r#71")).verdict).toBe("BLOCK");
    expect(d.store.receipt("o/r#71", head)?.verdict).toBe("BLOCK");
    await expect(mergeGate(d, "o/r#71", { dryRun: true })).rejects.toThrow("is BLOCK");
  });

  test("a failed review at one head leaves another head's receipt untouched", async () => {
    const { w, d } = setup();
    const older = "b".repeat(40);
    let current = older;
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: current }) };
      if (argv[1] === "checks") return { code: 0, stdout: JSON.stringify([{ name: "test", bucket: "pass" }]) };
      return { code: 0, stdout: "" };
    };
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await review(d, "o/r#72");

    current = head;
    w.reviewer = () => ({ code: 0, stdout: "no verdict here" });
    await expect(review(d, "o/r#72")).rejects.toThrow("no VERDICT");
    expect(d.store.receipt("o/r#72", older)?.verdict).toBe("CLEAR");
    expect(d.store.receipt("o/r#72", head)).toBeUndefined();
    await expect(mergeGate(d, "o/r#72", { dryRun: true })).rejects.toThrow("no review receipt");

    current = older;
    expect(await mergeGate(d, "o/r#72", { dryRun: true })).toBe(`MERGE_OK o/r#72 head=${older} (dry run)`);
  });

  test("a reviewer that cannot start cannot leave the older CLEAR receipt behind", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await review(d, "o/r#73");

    const deps = {
      ...d,
      exec: async (cmd: string) => {
        if (cmd === "gh") return { code: 0, stdout: JSON.stringify({ headRefOid: head }), stderr: "" };
        throw new Error("spawn omo ENOENT");
      },
    };
    await expect(review(deps, "o/r#73")).rejects.toThrow("spawn omo ENOENT");
    expect(d.store.receipt("o/r#73", head)).toBeUndefined();
    await expect(mergeGate(deps, "o/r#73", { dryRun: true })).rejects.toThrow("no review receipt");
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    expect((await review(d, "o/r#73")).verdict).toBe("CLEAR");
  });

  test("two overlapping reviews at one head: the second refuses, merge rejects the first, and a later review is eligible", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await review(d, "o/r#74");

    let release!: () => void;
    const finish = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const began = new Promise<void>((r) => (started = r));
    const deps = {
      ...d,
      exec: async (cmd: string, argv: readonly string[]) => {
        if (cmd === "gh")
          return {
            code: 0,
            stdout:
              argv[1] === "checks"
                ? JSON.stringify([{ name: "test", bucket: "pass" }])
                : JSON.stringify({ headRefOid: head }),
            stderr: "",
          };
        started();
        await finish;
        return { code: 0, stdout: "VERDICT: CLEAR", stderr: "" };
      },
    };
    const inflight = review(deps, "o/r#74");
    await began;
    expect(d.store.receipt("o/r#74", head)).toBeUndefined();
    await expect(mergeGate(deps, "o/r#74", { dryRun: true })).rejects.toThrow("review_in_progress");
    await expect(review(deps, "o/r#74")).rejects.toThrow("already in progress");

    release();
    expect((await inflight).verdict).toBe("CLEAR");
    expect(await mergeGate(deps, "o/r#74", { dryRun: true })).toBe(`MERGE_OK o/r#74 head=${head} (dry run)`);

    // The lock is gone: a later review can run, and its receipt is eligible again.
    expect((await review(deps, "o/r#74")).verdict).toBe("CLEAR");
    expect(await mergeGate(deps, "o/r#74", { dryRun: true })).toBe(`MERGE_OK o/r#74 head=${head} (dry run)`);
  });
});
