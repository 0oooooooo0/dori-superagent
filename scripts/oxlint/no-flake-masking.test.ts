import { beforeAll, describe, expect, test } from "bun:test";

import { type Finding, lintFixtures } from "./rule-findings.ts";

type Case = readonly [name: string, source: string];

const flakeCode = "dori-testing(no-flake-masking)";

const flagged: readonly Case[] = [
  ["a test retry option", 'test("loads", { retry: 2 }, async () => {});'],
  ["an it retry option", 'it("loads", { retry: 2 }, async () => {});'],
  ["a describe retry option", 'describe("loader", { retry: 3 }, () => {});'],
  ["a test.concurrent retry option", 'test.concurrent("loads", { retry: 1 }, async () => {});'],
  ["a test.each retry option", 'test.each([1, 2])("loads %i", { retry: 1 }, async () => {});'],
  ["a retry option in the third argument", 'test("loads", async () => {}, { retry: 2 });'],
  ["a vi.setConfig retry", "vi.setConfig({ retry: 2 });"],
  ["a defineConfig test retry", "export default defineConfig({ test: { retry: 2 } });"],
  [
    "a nested projects retry",
    "export default defineConfig({ test: { projects: [{ test: { name: 'node', retry: 1 } }] } });",
  ],
  ["a positional timeout literal", 'test("loads", async () => {}, 60_000);'],
  ["a positional timeout expression", 'test("loads", async () => {}, 2 * 60_000);'],
  ["a positional timeout identifier", 'test("loads", async () => {}, LONG_TIMEOUT);'],
  ["a timeout option in the second argument", 'test("loads", { timeout: 60_000 }, async () => {});'],
  ["a timeout option in the third argument", 'test("loads", async () => {}, { timeout: 60_000 });'],
  ["a describe timeout option", 'describe("loader", { timeout: 60_000 }, () => {});'],
  ["a vi.setConfig testTimeout", "vi.setConfig({ testTimeout: 45_000 });"],
  ["a vi.setConfig hookTimeout", "vi.setConfig({ hookTimeout: 45_000 });"],
];

const allowed: readonly Case[] = [
  ["a plain test", 'test("loads", async () => {});'],
  ["an unrelated option", 'test("loads", { tags: ["slow"] }, async () => {});'],
  ["a concurrent option", 'test("loads", { concurrent: true }, function load() {});'],
  ["a beforeAll timeout", "beforeAll(async () => { await server.listen(); }, 60_000);"],
  ["an afterAll timeout", "afterAll(() => server.close(), 30_000);"],
  ["an expect.poll timeout", "await expect.poll(() => count(), { timeout: 5_000 }).toBe(1);"],
  ["a vi.waitFor timeout", "await vi.waitFor(() => expect(count()).toBe(1), { timeout: 5_000 });"],
  ["a non-test retry option", "const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });"],
  ["a queue retry call", "queue.retry({ delaySeconds: 30 });"],
  ["a policy retry object", "const policy = { retry: { maxAttempts: 1 } };"],
  [
    "a defineConfig default timeout",
    "export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 60_000 } });",
  ],
  ["a vi.setConfig fakeTimers", "vi.setConfig({ fakeTimers: { now: 0 } });"],
];

// One oxlint run for every fixture in this file; each test reads its own case's findings.
let results: Finding[][] = [];
const codesAt = (index: number): string[] => (results[index] ?? []).map((finding) => finding.code);

describe("no-flake-masking through the ratchet lint configuration", () => {
  beforeAll(() => {
    results = lintFixtures([...flagged, ...allowed].map(([, source]) => source));
  });
  flagged.forEach(([name], index) => {
    test(`reports ${name}`, () => {
      expect(codesAt(index)).toEqual([flakeCode]);
    });
  });
  allowed.forEach(([name], index) => {
    test(`allows ${name}`, () => {
      expect(codesAt(flagged.length + index)).toEqual([]);
    });
  });
});
