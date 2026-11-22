import { invoke } from "@tauri-apps/api/core";
import { boardSizes, createBoardFixture } from "../../../bench/fixtures/boards";
import { id, makeCard, type Edge, type OpenBoard, type Stroke } from "./model";

export async function openBenchmark(fixture: string) {
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
    format: "dev.local.visualboard.board", schemaVersion: 1, title: fixture, nodes, edges,
    drawing: { strokes, labels: [], arrows: [] },
  });
  return invoke<OpenBoard>("open_benchmark", { fixture, input });
}
