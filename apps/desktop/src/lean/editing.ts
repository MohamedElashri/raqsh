import { id, type Arrow, type Card, type Change, type Drawing, type Id, type Point, type Stroke } from "../model.ts";
import type { Board } from "./board";
import { getStrokeBounds, type Bounds } from "./geometry.ts";

export const drawingKinds = ["strokes", "arrows", "labels"] as const;
export type DrawingKind = typeof drawingKinds[number];
export type Mark = Drawing[DrawingKind][number];
export type MarkChange = { kind: DrawingKind; index: number; before?: Mark; after?: Mark };
export type Selection = { cards: Set<Id>; marks: Set<Mark>; edges: Set<Id> };
export type Target = { kind: "cards" | "edges"; id: Id } | { kind: "marks"; mark: Mark };
export type BoardEdit = { changes: Change[]; marks: MarkChange[] };

export const emptySelection = (): Selection => ({ cards: new Set(), marks: new Set(), edges: new Set() });
export const selectionSize = (selection: Selection) => selection.cards.size + selection.marks.size + selection.edges.size;
export const geometry = (value: number) => Math.round(Math.max(-100_000, Math.min(100_000, value)) * 100) / 100;

export function topmost<T>(items: readonly T[], test: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    if (test(items[index])) return items[index];
  }
}

export function selectedTarget(selection: Selection, target: Target) {
  return target.kind === "marks" ? selection.marks.has(target.mark) : selection[target.kind].has(target.id);
}

export function toggleTarget(selection: Selection, target: Target, extend: boolean): Selection {
  const next = extend ? { cards: new Set(selection.cards), marks: new Set(selection.marks), edges: new Set(selection.edges) }
    : emptySelection();
  if (target.kind === "marks") {
    if (!next.marks.delete(target.mark)) next.marks.add(target.mark);
  } else if (!next[target.kind].delete(target.id)) next[target.kind].add(target.id);
  return next;
}

export function removeSelection(board: Board, selection: Selection): BoardEdit {
  const changes: Change[] = [];
  for (const edge of board.edges) {
    if (selection.edges.has(edge.id) || selection.cards.has(edge.from) || selection.cards.has(edge.to)) {
      changes.push({ type: "removeEdge", id: edge.id });
    }
  }
  for (const card of board.nodes) {
    if (selection.cards.has(card.id)) changes.push({ type: "removeNode", id: card.id });
    else if (card.parent && selection.cards.has(card.parent)) {
      changes.push({ type: "setNode", node: { ...card, parent: null } });
    }
  }
  const marks: MarkChange[] = [];
  for (const kind of drawingKinds) {
    for (let index = board[kind].length - 1; index >= 0; index--) {
      const mark = board[kind][index];
      if (selection.marks.has(mark)) marks.push({ kind, index, before: mark });
    }
  }
  return { changes, marks };
}

export function applyMarks(drawing: Drawing, changes: readonly MarkChange[]) {
  let pointDelta = 0;
  for (const { kind, index, before, after } of changes) {
    const marks: Mark[] = drawing[kind];
    if (after) marks.splice(index, before ? 1 : 0, after);
    else marks.splice(index, 1);
    pointDelta += (after && "points" in after ? after.points.length : 0)
      - (before && "points" in before ? before.points.length : 0);
  }
  return pointDelta;
}

export function invertMarks(marks: readonly MarkChange[]): MarkChange[] {
  return marks.slice().reverse().map(({ kind, index, before, after }) => ({ kind, index, before: after, after: before }));
}

export function cardBounds(card: Card): Bounds {
  return { left: card.x, top: card.y, right: card.x + card.width, bottom: card.y + card.height };
}

export function boxBetween([x, y]: Point, [otherX, otherY]: Point): Bounds {
  return { left: Math.min(x, otherX), top: Math.min(y, otherY), right: Math.max(x, otherX), bottom: Math.max(y, otherY) };
}

export function within(box: Bounds, region: Bounds) {
  return box.left >= region.left && box.top >= region.top && box.right <= region.right && box.bottom <= region.bottom;
}

export function includesPoint(box: Bounds, [x, y]: Point, padding = 0) {
  return x >= box.left - padding && x <= box.right + padding && y >= box.top - padding && y <= box.bottom + padding;
}

export function movableBounds(cards: readonly Card[], marks: Iterable<Mark>, cache: WeakMap<Stroke, Bounds>): Bounds {
  const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  function include(box: Bounds) {
    bounds.left = Math.min(bounds.left, box.left);
    bounds.top = Math.min(bounds.top, box.top);
    bounds.right = Math.max(bounds.right, box.right);
    bounds.bottom = Math.max(bounds.bottom, box.bottom);
  }
  for (const { x, y } of cards) include(boxBetween([x, y], [x, y]));
  for (const mark of marks) {
    if ("points" in mark) {
      include(getStrokeBounds(mark, cache));
      include(boxBetween([mark.x, mark.y], [mark.x, mark.y]));
    } else if ("from" in mark) include(boxBetween(mark.from, mark.to));
    else include(boxBetween([mark.x, mark.y], [mark.x, mark.y]));
  }
  return bounds;
}

export function boundedOffset([dx, dy]: Point, box: Bounds): Point {
  return [Math.max(-100_000 - box.left, Math.min(100_000 - box.right, dx)),
    Math.max(-100_000 - box.top, Math.min(100_000 - box.bottom, dy))];
}

export function translateMark(mark: Mark, [dx, dy]: Point): Mark {
  if ("from" in mark) {
    const shift = ([x, y]: Point): Point => [x + dx, y + dy];
    return { ...mark, from: shift(mark.from), to: shift(mark.to) } satisfies Arrow;
  }
  return { ...mark, x: mark.x + dx, y: mark.y + dy };
}

export function duplicateSelection(board: Board, selection: Selection, offset: Point): BoardEdit & { selected: Selection } {
  const selected = emptySelection();
  const changes: Change[] = [];
  const marks: MarkChange[] = [];
  const copies = new Map([...selection.cards].map((old) => [old, id()]));
  let order = board.nodes.at(-1)?.order ?? -1;
  for (const card of board.nodes) {
    const copy = copies.get(card.id);
    if (!copy) continue;
    selected.cards.add(copy);
    changes.push({ type: "setNode", node: { ...card, id: copy, revision: 0, statusSource: undefined,
      parent: card.parent ? copies.get(card.parent) ?? card.parent : null,
      order: Math.min(1_000_000_000, ++order), x: card.x + offset[0], y: card.y + offset[1] } });
  }
  for (const edge of board.edges) {
    const from = copies.get(edge.from);
    const to = copies.get(edge.to);
    if (from && to) changes.push({ type: "setEdge", edge: { ...edge, id: id(), from, to, revision: 0 } });
  }
  for (const kind of drawingKinds) {
    let index = board[kind].length;
    for (const mark of board[kind]) {
      if (!selection.marks.has(mark)) continue;
      const after = translateMark(mark, offset);
      if ("points" in after) after.id = id();
      selected.marks.add(after);
      marks.push({ kind, index: index++, after });
    }
  }
  return { changes, marks, selected };
}
