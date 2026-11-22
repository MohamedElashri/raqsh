export const boardSizes = {
  empty: { nodes: 0, edges: 0, strokes: 0 },
  tiny: { nodes: 10, edges: 5, strokes: 0 },
  ordinary: { nodes: 50, edges: 30, strokes: 50 },
  normal: { nodes: 200, edges: 100, strokes: 300 },
  stress: { nodes: 500, edges: 500, strokes: 2_000 },
} as const;

export type BoardSize = keyof typeof boardSizes;

type Point = [number, number];

const tasks = [
  "Verify the release build on Wayland",
  "Trace the drawing checkpoint",
  "Write the board migration notes",
  "Confirm project scope for agent feedback",
  "Record the pinned WebKit version",
  "Measure idle memory across processes",
  "Test keyboard selection and undo",
  "Compare Linux package dependencies",
  "Review Arabic text and clipboard input",
  "Reproduce the stale revision conflict",
];

export function createBoardFixture(size: BoardSize) {
  const counts = boardSizes[size];
  const nodes = Array.from({ length: counts.nodes }, (_, index) => ({
    id: `task-${index + 1}`,
    title: `${tasks[index % tasks.length]}\nTask ${index + 1}`,
    x: (index % 5) * 318 + 80,
    y: Math.floor(index / 5) * 162 + 80,
    width: 216,
    height: 86,
  }));
  const edges = Array.from({ length: counts.edges }, (_, index) => {
    const last = size === "stress" && index === counts.edges - 1;
    const from = last ? 0 : Math.floor(index * nodes.length / counts.edges);
    return { id: `dependency-${index + 1}`, from: nodes[from], to: nodes[last ? nodes.length - 1 : from + 1] };
  });
  const strokes = Array.from({ length: counts.strokes }, (_, index) => {
    const node = nodes[index % nodes.length];
    const layer = Math.floor(index / nodes.length);
    const points = Array.from({ length: 16 + index % 13 }, (_, point): Point => [
      3 * point,
      Math.round(7 * Math.sin(point / 4) + 3 * Math.sin(point / 2)),
    ]);
    return { id: `stroke-${index + 1}`, x: node.x + 14, y: node.y + 101 + layer * 15, points };
  });
  return { nodes, edges, strokes };
}
