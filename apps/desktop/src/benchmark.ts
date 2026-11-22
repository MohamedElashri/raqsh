import { invoke } from "@tauri-apps/api/core";
import { boardSizes, createBoardFixture } from "../../../bench/fixtures/boards";
import { id, makeCard, type Card, type Drawing, type Edge, type OpenBoard, type Stroke } from "./model";

function showcase() {
  const cards: [string, number, number, Card["status"]][] = [
    ["Map the first-run flow", 68, 154, "done"],
    ["Prototype the welcome screen", 370, 154, "inProgress"],
    ["Run a clean-install test", 672, 154, "todo"],
    ["Audit keyboard navigation", 68, 374, "done"],
    ["Review the empty states", 370, 374, "inProgress"],
    ["Ready for review", 672, 374, "todo"],
  ];
  const nodes = cards.map(([title, x, y, status], order) => ({ ...makeCard(title, [x, y], order), status }));
  const edges = [[0, 1], [1, 2], [3, 4], [4, 5]].map(([from, to]) => ({
    id: id(), from: nodes[from].id, to: nodes[to].id, kind: "dependency", revision: 0,
  }));
  const drawing: Drawing = {
    labels: [
      { x: 69, y: 95, text: "ONBOARDING REFRESH" },
      { x: 69, y: 136, text: "First-run flow" },
      { x: 69, y: 350, text: "Accessibility and polish" },
      { x: 378, y: 282, text: "Keep the first decision obvious." },
      { x: 675, y: 525, text: "Validate on a fresh profile." },
    ],
    strokes: [
      { id: id(), x: 69, y: 108, color: "blue", width: 2, points: [[0, 2], [56, 0], [123, 2], [204, 1]] },
      { id: id(), x: 378, y: 293, color: "blue", width: 2, points: [[0, 0], [100, 2], [211, 0]] },
    ],
    arrows: [{ from: [778, 500], to: [778, 465], color: "blue" }],
  };
  return { nodes, edges, drawing };
}

export async function openBenchmark(fixture: string) {
  if (fixture === "showcase") {
    const input = JSON.stringify({ format: "dev.local.raqsh.board", schemaVersion: 1, title: fixture, ...showcase() });
    return invoke<OpenBoard>("open_benchmark", { fixture, input });
  }
  if (!Object.hasOwn(boardSizes, fixture)) throw new Error("Unknown board fixture.");
  const sample = createBoardFixture(fixture as keyof typeof boardSizes);
  const nodes = sample.nodes.map((node, index) => ({
    ...makeCard(node.title, [node.x, node.y], index),
    ...(fixture === "stress" ? { description: ("Review the dependency, check the stored revision and verify the local drawing before reporting the result. ").repeat(6) } : {}),
  }));
  const ids = new Map(sample.nodes.map((node, index) => [node.id, nodes[index].id]));
  const edges = sample.edges.map(({ from, to }): Edge => ({
    id: id(), from: ids.get(from.id)!, to: ids.get(to.id)!, kind: "dependency", revision: 0,
  }));
  const strokes = sample.strokes.map((stroke): Stroke => ({ ...stroke, color: "slate", width: 3 }));
  const input = JSON.stringify({
    format: "dev.local.raqsh.board", schemaVersion: 1, title: fixture, nodes, edges,
    drawing: { strokes, labels: [], arrows: [] },
  });
  return invoke<OpenBoard>("open_benchmark", { fixture, input });
}
