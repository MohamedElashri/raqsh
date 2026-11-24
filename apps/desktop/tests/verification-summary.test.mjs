import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewSummary } from "../src/lean/verification-summary.ts";

test("review summary distinguishes task status from dated verification", () => {
  const cards = [
    { id: "done", order: 1, kind: "task", status: "done", title: "Package [Linux]" },
    { id: "blocked", order: 2, kind: "task", status: "blocked", title: "Ship #release" },
    { id: "extra", order: 3, kind: "task", status: "done", title: "Check metadata" },
    { id: "dropped", order: 0, kind: "task", status: "done", title: "Dropped", dropped: true },
  ];
  const record = (cardId, title, result, revision = "") => ({
    id: title, cardId, recordedAt: Date.UTC(2026, 1, 3),
    check: { title, result, revision },
  });
  const markdown = reviewSummary("Build\n## Embedded title", cards, [
    record("done", "Install succeeds", "passed", "123abc"),
    record("blocked", "CI failed", "failed", "aa4455"),
    record("blocked", "Retry locally", "pending"),
    record("dropped", "Hidden", "pending"),
    record("missing", "Detached", "passed"),
  ]);
  assert.match(markdown, /# Review · Build \\#\\# Embedded title/);
  assert.match(markdown, /- Package \\\[Linux\\\]/);
  assert.match(markdown, /Passed.*Install succeeds.*Revision 123abc.*2026-02-03 UTC · Manual/);
  assert.match(markdown, /Failed.*CI failed.*Revision aa4455/);
  assert.match(markdown, /Pending.*Retry locally/);
  assert.match(markdown, /Check metadata — No check recorded/);
  assert.doesNotMatch(markdown, /Dropped|Hidden|Detached/);
});
