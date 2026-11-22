import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

export type Id = string;
export type Point = [number, number];
export type Project = { id: Id; title: string; root: string };
export type BoardInfo = {
  id: Id; projectId: Id; title: string; schemaVersion: number;
  semanticRevision: number; drawingRevision: number; createdAt: number; updatedAt: number;
};
export type Scope = { projectId: Id; boardId: Id; instance: Id };
export type Page<T> = { items: T[]; nextOffset: number | null };

export const kinds = {
  task: "Task", decision: "Decision", question: "Question", blocker: "Blocker", group: "Group", note: "Note",
};
export const statuses = { todo: "To do", inProgress: "In progress", blocked: "Blocked", done: "Done" };
export const priorities = { low: "Low", normal: "Normal", high: "High" };
export type Card = {
  id: Id; kind: keyof typeof kinds; title: string; description: string; status: keyof typeof statuses;
  statusSource?: Id; priority: keyof typeof priorities; dropped: boolean; x: number; y: number; width: number; height: number;
  parent: Id | null; order: number; revision: number;
};
export type Edge = { id: Id; from: Id; to: Id; kind: "dependency" | "annotation"; revision: number };
export type Ink = "green" | "slate" | "blue" | "red";
export type Stroke = { id: string; x: number; y: number; points: Point[]; color: Ink; width: number };
export type Label = { x: number; y: number; text: string };
export type Arrow = { from: Point; to: Point; color: Ink };
export type ExcalidrawScene = {
  version: 1; elements: readonly ExcalidrawElement[]; files: BinaryFiles; background: string; gridSize: number | null;
};
export type Drawing = { strokes: Stroke[]; labels: Label[]; arrows: Arrow[]; excalidraw?: ExcalidrawScene };
export type OpenBoard = { board: BoardInfo; scope: Scope; nodes: Card[]; edges: Edge[]; drawing: Drawing };
export type Change =
  | { type: "setNode"; node: Card } | { type: "removeNode"; id: Id }
  | { type: "setEdge"; edge: Edge } | { type: "removeEdge"; id: Id };
export type Operation = { id: Id; expectedRevision: number; changes: Change[] };
export type Receipt = { revision: number; changes: Change[]; inverse: Change[]; committedAt: number; reducerMicros: number };

export function id(): Id {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

export function makeCard(title: string, [x, y]: Point, order: number): Card {
  return { id: id(), title, x, y, order, width: 216, height: 86, kind: "task", description: "",
    status: "todo", priority: "normal", dropped: false, parent: null, revision: 0 };
}
