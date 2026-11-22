import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMarks, boundedOffset, duplicateSelection, emptySelection, invertMarks, movableBounds, removeSelection,
  translateMark } from "../src/lean/editing.ts";
import { makeCard } from "../src/model.ts";

test("deleting a group removes its incident links and keeps unselected children", () => {
  const group = { ...makeCard("Group", [0, 0], 0), kind: "group" };
  const child = { ...makeCard("Child", [10, 10], 1), parent: group.id };
  const unrelated = makeCard("Other", [500, 10], 2);
  const edge = { id: "edge", from: group.id, to: child.id, kind: "dependency", revision: 0 };
  const otherEdge = { ...edge, id: "other", from: child.id, to: unrelated.id };
  const board = { nodes: [group, child, unrelated], edges: [edge, otherEdge], strokes: [], labels: [], arrows: [] };
  const selection = emptySelection();
  selection.cards.add(group.id);
  const removed = removeSelection(board, selection);
  assert.deepEqual(removed.changes, [
    { type: "removeEdge", id: edge.id },
    { type: "removeNode", id: group.id },
    { type: "setNode", node: { ...child, parent: null } },
  ]);
  assert.deepEqual(removed.marks, []);
});

test("duplicating cards remaps group membership and copies internal dependencies", () => {
  const group = { ...makeCard("Group", [0, 0], 0), kind: "group" };
  const child = { ...makeCard("Child", [10, 10], 1), parent: group.id, statusSource: "agent" };
  const unrelated = makeCard("Other", [500, 10], 2);
  const edge = { id: "edge", from: group.id, to: child.id, kind: "dependency", revision: 1 };
  const board = { nodes: [group, child, unrelated], edges: [edge, { ...edge, from: child.id, to: unrelated.id }],
    strokes: [], labels: [], arrows: [] };
  const selection = emptySelection();
  selection.cards = new Set([group.id, child.id]);
  const { changes } = duplicateSelection(board, selection, [24, 24]);
  assert.equal(changes.length, 3);
  const [copy, copiedChild] = changes.map((change) => change.node);
  assert.notEqual(copy.id, group.id);
  assert.equal(copiedChild.parent, copy.id);
  assert.equal(copiedChild.statusSource, undefined);
  assert.equal(copiedChild.x, 34);
  assert.deepEqual({ ...changes[2].edge, id: edge.id }, { ...edge, from: copy.id, to: copiedChild.id, revision: 0 });
});

test("drawing history restores removed marks in their original order and preserves point counts", () => {
  const stroke = { id: "old", x: 0, y: 0, width: 2, color: "slate", points: [[0, 0], [20, 20]] };
  const marks = Array.from({ length: 4 }, (_, index) => ({ ...stroke, id: String(index) }));
  const board = { nodes: [], edges: [], strokes: marks.slice(), arrows: [], labels: [] };
  const selection = emptySelection();
  selection.marks = new Set([marks[0], marks[1], marks[3]]);
  const removed = removeSelection(board, selection).marks;
  assert.equal(applyMarks(board, removed), -6);
  assert.deepEqual(board.strokes, [marks[2]]);
  assert.equal(applyMarks(board, invertMarks(removed)), 6);
  assert.deepEqual(board.strokes, marks);
});

test("moving objects stays within board coordinates as a group", () => {
  const arrow = { from: [99_999, 2], to: [99_998, 3], color: "slate" };
  const stroke = { x: 99_991, y: 0, width: 2, points: [[0, 0], [8, 12]] };
  const box = movableBounds([], [arrow, stroke], new WeakMap());
  const offset = boundedOffset([25, -4], box);
  assert.deepEqual(offset, [1, -4]);
  assert.deepEqual(translateMark(arrow, offset), { ...arrow, from: [100_000, -2], to: [99_999, -1] });
  assert.equal(translateMark(stroke, offset).x, 99_992);
});
