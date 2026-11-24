import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentBrief } from "../src/lean/agent-brief.ts";
import { makeCard } from "../src/model.ts";

function card(title, id, order, fields = {}) {
  return { ...makeCard(title, [0, 0], order), id, ...fields };
}

function edge(from, to, kind = "dependency") {
  return { id: `${from}-${to}`, from, to, kind, revision: 0 };
}

test("a selection describes only chosen cards and names their prerequisites", () => {
  const cards = [
    card("Inspect logs", "inspect", 0, { status: "done", description: "Do not copy this." }),
    card("Capture fixture", "capture", 1, { status: "blocked", dropped: true }),
    card("Fix [parser]", "fix", 2, { status: "todo", description: "    cargo test\r\n\r\nRun the Unicode test." }),
    card("Unrelated", "other", 3, { description: "Do not copy this either." }),
  ];
  const report = createAgentBrief("Release *notes*\nwork", cards,
    [edge("capture", "fix"), edge("inspect", "fix"), edge("fix", "capture"), edge("other", "fix", "annotation")],
    new Set(["fix", "missing"]));
  assert.match(report.markdown, /^# Agent brief · Release \\\*notes\\\* work/);
  assert.match(report.markdown, /### Fix \\\[parser\\\]/);
  assert.match(report.markdown, /Requires: Inspect logs \(Done\)\n- Requires: Capture fixture \(Dropped · Blocked\)/);
  assert.match(report.markdown, />     cargo test\n>\n> Run the Unicode test\./);
  assert.doesNotMatch(report.markdown, /Do not copy|Unrelated/);
  assert.equal(report.withContext, undefined);
  assert.equal(createAgentBrief("Release", cards, [], new Set()), undefined);
});

test("optional task brief can be included without duplicating a selected or dropped note", () => {
  const cards = [
    card("Task brief", "brief", 0, { kind: "note", description: "Ship offline.\nhttps://github.com/example/repo/issues/2" }),
    card("Task brief", "dropped", 1, { kind: "note", description: "Outdated", dropped: true }),
    card("Ship package", "ship", 2),
  ];
  const preview = createAgentBrief("Release", cards, [], new Set(["ship"]));
  assert.doesNotMatch(preview.markdown, /Ship offline/);
  assert.match(preview.withContext, /## Task brief\n\n> Ship offline\.\n> https:/);
  assert.doesNotMatch(preview.withContext, /Outdated/);
  const selected = createAgentBrief("Release", cards, [], new Set(["ship", "brief"]));
  assert.match(selected.markdown, /### Task brief/);
  assert.equal(selected.withContext, undefined);
});

test("a 500-card checklist renders its selected graph without recursion", () => {
  const cards = Array.from({ length: 500 }, (_, index) => card(`Task ${index}`, String(index), index));
  const links = cards.slice(1).map(({ id }, index) => edge(String(index), id));
  links.push(edge("499", "0"));
  const result = createAgentBrief("Review", cards, links, new Set(cards.map(({ id }) => id)));
  assert.equal(result.markdown.match(/^### Task /gm).length, 500);
  assert.equal(result.markdown.match(/^- Requires: /gm).length, 500);
});
