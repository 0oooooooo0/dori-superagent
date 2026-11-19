import { describe, expect, it } from "bun:test";

import { compare, countByFile, countSuppressions, ratchetedFiles, SUPPRESSION } from "./lint-ratchet.ts";

const root = "/repo";
const sleep = "dori-testing/no-fixed-sleep";
const flake = "dori-testing/no-flake-masking";
const moduleMock = "dori-testing/no-module-mock";

describe("lint ratchet", () => {
  it("counts findings per file and rule, relative to the repo root", () => {
    const counts = countByFile(
      [
        { code: "dori-testing(no-module-mock)", filename: "src/a.test.ts" },
        { code: "dori-testing(no-module-mock)", filename: "/repo/src/a.test.ts" },
        { code: "dori-testing(no-fixed-sleep)", filename: "src/a.test.ts" },
        { code: "dori-testing(no-flake-masking)", filename: "scripts/b.test.ts" },
      ],
      root,
    );
    expect(counts).toEqual({
      "src/a.test.ts": { [moduleMock]: 2, [sleep]: 1 },
      "scripts/b.test.ts": { [flake]: 1 },
    });
  });

  it("refuses a count that goes up, including any finding in a file the baseline does not list", () => {
    const { increases } = compare(
      { "src/a.test.ts": { [moduleMock]: 2 } },
      { "src/a.test.ts": { [moduleMock]: 3 }, "src/new.test.ts": { [sleep]: 1 } },
    );
    expect(increases).toEqual([
      { file: "src/a.test.ts", rule: moduleMock, before: 2, after: 3 },
      { file: "src/new.test.ts", rule: sleep, before: 0, after: 1 },
    ]);
  });

  it("reports a count that goes down, so the baseline must be lowered in the same change", () => {
    const { increases, decreases } = compare(
      { "src/a.test.ts": { [flake]: 2 }, "src/gone.test.ts": { [moduleMock]: 1 } },
      { "src/a.test.ts": { [flake]: 2 } },
    );
    expect(increases).toEqual([]);
    expect(decreases).toEqual([{ file: "src/gone.test.ts", rule: moduleMock, before: 1, after: 0 }]);
  });

  it("accepts counts that match the baseline exactly", () => {
    const counts = { "src/a.test.ts": { [flake]: 2 } };
    expect(compare(counts, counts)).toEqual({ increases: [], decreases: [] });
  });

  it("counts every disable comment that names a ratcheted rule or disables every rule", () => {
    // Built at runtime so this file holds no directive of its own for the gate to count.
    const line = "/".repeat(2);
    const block = ["/", "*"].join("");
    const source = [
      `${line} oxlint-disable-next-line dori-testing/no-fixed-sleep`,
      `${line} eslint-disable-next-line dori-testing/no-flake-masking -- legacy`,
      `${block} eslint-disable */`,
      `const a = 1; ${line} oxlint-disable-line`,
      `${line} oxlint-disable-next-line dori-testing/no-module-mock, eslint/no-console`,
      `${line} oxlint-disable-next-line eslint/no-console -- unrelated rule, not counted`,
      `const text = "oxlint-disable-next-line dori-testing/no-module-mock";`,
      `${block}\n  eslint-disable-next-line dori-testing/no-module-mock\n*/`,
    ].join("\n");
    expect(countSuppressions("probe.ts", source)).toBe(6);
    expect(countSuppressions("probe.ts", "const x = 1;\n")).toBe(0);
  });

  it("refuses a new disable comment like any other rise", () => {
    const { increases } = compare({}, { "scripts/probe.ts": { [SUPPRESSION]: 1 } });
    expect(increases).toEqual([{ file: "scripts/probe.ts", rule: SUPPRESSION, before: 0, after: 1 }]);
  });

  it("ratchets only JS/TS sources", () => {
    expect(ratchetedFiles(["src/a.ts", "src/b.mjs", "README.md", "package.json"])).toEqual(["src/a.ts", "src/b.mjs"]);
  });
});
