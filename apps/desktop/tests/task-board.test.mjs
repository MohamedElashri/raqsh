import assert from "node:assert/strict";
import { test } from "node:test";
import { checklistSteps, maxTaskTitleLength, suggestTaskTitle, taskBoardDocument, taskTemplates } from "../src/task-board.ts";

test("suggesting a title handles Markdown, pasted line endings, and Unicode limits", () => {
  assert.equal(suggestTaskTitle("\n  ## Fix compact layout ##\r\nMore context"), "Fix compact layout");
  assert.equal(suggestTaskTitle("Fix compact layout\rMore context"), "Fix compact layout");
  assert.equal(suggestTaskTitle(" Keep C# working\nTest it"), "Keep C# working");
  assert.equal(suggestTaskTitle("- [ ] Reopen the board\n- [ ] Verify its drawing"), "Reopen the board");
  assert.equal(suggestTaskTitle("\n  \t"), "");
  const prefix = "工".repeat(maxTaskTitleLength - 1);
  assert.equal(suggestTaskTitle(`${prefix}🚀`), prefix);
});

test("all templates create an editable brief and ordered dependency chain", () => {
  for (const [source, template] of Object.entries(taskTemplates)) {
    const brief = "  مقدمة للمهمة\n\n    Keep the indentation.\n";
    const draft = template.steps.map((step) => ({ ...step }));
    draft[1] = { title: " Change the release check ", description: "Verify the new installation path." };
    const board = JSON.parse(taskBoardDocument(" Check the package ", brief, draft, source));
    assert.equal(board.format, "dev.local.raqsh.board");
    assert.equal(board.schemaVersion, 1);
    assert.equal(board.title, "Check the package");
    const [context, first, second, third] = board.nodes;
    assert.equal(context.kind, "note");
    assert.equal(context.description, brief);
    assert.equal(first.title, template.steps[0].title);
    assert.equal(second.title, "Change the release check");
    assert.equal(second.description, draft[1].description);
    assert.equal(third.title, template.steps[2].title);
    assert.deepEqual(board.nodes.map((node) => node.order), [0, 1, 2, 3]);
    assert.equal(new Set(board.nodes.map((node) => node.id)).size, 4);
    assert.deepEqual(board.edges.map(({ kind, from, to }) => [kind, from, to]), [
      ["dependency", first.id, second.id], ["dependency", second.id, third.id],
    ]);
  }
});

test("checklist parsing preserves order and state and skips examples and prose", () => {
  const brief = ["Triage the installer", "- [ ] Capture startup", "2) [X] Check Ubuntu", "* [x] Check Fedora",
    "- Plain bullet", "> - [ ] Quoted task", "    - [ ] Indented code", "- [ ]   ",
    "````md", "- [ ] Example", "```", "- [X] Still an example", "````", "~~~", "- [ ] Example again", "~~~",
    "```inline```", "+ [ ] راجع التثبيت", "- [x] Capture startup"].join("\r\n");
  const tasks = checklistSteps(brief);
  assert.deepEqual(tasks.map(({ step }) => [step.title, step.status]), [
    ["Capture startup", "todo"], ["Check Ubuntu", "done"], ["Check Fedora", "done"],
    ["راجع التثبيت", "todo"], ["Capture startup", "done"],
  ]);
  assert.equal(new Set(tasks.map(({ key }) => key)).size, tasks.length);
  assert.deepEqual(checklistSteps(brief.replace("- [ ] Capture", "- [x] Capture")).map(({ key }) => key),
    tasks.map(({ key }) => key));
  assert.deepEqual(checklistSteps("```md\n- [ ] Unclosed example"), []);
});

test("checklist boards keep full long items and wrap rows without inferring dependencies", () => {
  const long = `${"工".repeat(maxTaskTitleLength - 1)}🚀 review on Linux`;
  const brief = `# Test release builds\n- [x] ${long}\n- [ ] Fedora\n- [ ] macOS\n- [ ] Ubuntu`;
  const tasks = checklistSteps(brief).map(({ step }) => step);
  const board = JSON.parse(taskBoardDocument("Test release builds", brief, tasks, "checklist"));
  assert.equal(board.nodes[0].description, brief);
  assert.equal(board.nodes[1].status, "done");
  assert.equal(board.nodes[1].title, "工".repeat(maxTaskTitleLength - 1));
  assert.equal(board.nodes[1].description, long);
  assert.equal(board.nodes[4].x, board.nodes[1].x);
  assert.ok(board.nodes[4].y > board.nodes[1].y);
  assert.deepEqual(board.edges, []);
});
