import { convertToExcalidrawElements, FONT_FAMILY } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, ExcalidrawFreeDrawElement } from "@excalidraw/excalidraw/element/types";
import { id, type Card, type Edge, type Ink, type Point } from "../model";
import { geometry, type DrawingKind, type Mark } from "./editing";
import { outline, type Shape } from "./geometry";

const palette: Record<Ink, string> = { green: "#1b1b19", slate: "#1b1b19", blue: "#2862a3", red: "#a74a41" };
const stroke = { roughness: 0, strokeWidth: 2, roundness: null, strokeColor: palette.slate } as const;
// Perfect Freehand's outline is wider than the legacy line width at the same numeric value.
export const penWidthScale = 3;
const exact = { regenerateIds: false };
const localPoints = (points: Point[]) => points as unknown as ExcalidrawFreeDrawElement["points"];
export const cardId = (key: string) => `raqsh-card-${key}`;
export const edgeId = (key: string) => `raqsh-edge-${key}`;

export function cardElements(cards: Card[], edges: Edge[]) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  return convertToExcalidrawElements([
    ...edges.flatMap((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return [];
      const x = from.x + from.width;
      const y = from.y + from.height / 2;
      return [{ ...stroke, type: "arrow" as const, id: edgeId(edge.id), x, y,
        points: localPoints([[0, 0], [to.x - x, to.y + to.height / 2 - y]]),
        start: { id: cardId(from.id) }, end: { id: cardId(to.id) },
        strokeColor: "#77746c", strokeWidth: edge.kind === "dependency" ? 1.5 : 1 }];
    }),
    ...cards.map((card) => ({
      ...stroke, type: "rectangle" as const, id: cardId(card.id), x: card.x, y: card.y,
      width: card.width, height: card.height, customData: { raqshCard: card.id }, opacity: 0, backgroundColor: "#e5e5e0", fillStyle: "solid" as const,
    })),
  ], exact);
}

function shapeOf(points: Point[]) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  const shapes: Shape[] = points.length === 5 ? ["rectangle", "diamond"] : points.length === 49 ? ["ellipse"] : [];
  const type = shapes.find((shape) => outline(shape, [width, height]).every(([px, py], index) =>
    Math.abs(px + x - points[index][0]) < 0.02 && Math.abs(py + y - points[index][1]) < 0.02));
  return type && { type, x, y, width, height };
}

export function markElement(mark: Mark, key: string): ExcalidrawElement {
  if ("text" in mark) {
    return convertToExcalidrawElements([{ ...stroke, id: key, type: "text", x: mark.x, y: mark.y - 17,
      text: mark.text, fontSize: 17, fontFamily: FONT_FAMILY.Excalifont }], exact)[0];
  }
  if ("from" in mark) {
    const [x, y] = mark.from;
    return convertToExcalidrawElements([{ ...stroke, id: key, type: "arrow", x, y, strokeColor: palette[mark.color],
      points: localPoints([[0, 0], [mark.to[0] - x, mark.to[1] - y]]) }], exact)[0];
  }
  const style = { ...stroke, id: key, strokeColor: palette[mark.color], strokeWidth: mark.width };
  const shape = shapeOf(mark.points);
  if (shape && shape.width && shape.height) {
    return convertToExcalidrawElements([{ ...style, ...shape, x: mark.x + shape.x, y: mark.y + shape.y }], exact)[0];
  }
  const [x, y] = mark.points[0];
  const points = mark.points.map(([px, py]): Point => [px - x, py - y]);
  if (points.length === 2 && (points[1][0] || points[1][1])) {
    return convertToExcalidrawElements([{ ...style, type: "line", x: mark.x + x, y: mark.y + y,
      width: Math.abs(points[1][0]), height: Math.abs(points[1][1]), points: localPoints(points) }], exact)[0];
  }
  const [base] = convertToExcalidrawElements([{ ...style, type: "rectangle", x: mark.x + x, y: mark.y + y,
    width: Math.max(...points.map(([px]) => px)) - Math.min(...points.map(([px]) => px)),
    height: Math.max(...points.map(([, py]) => py)) - Math.min(...points.map(([, py]) => py)) }], exact);
  return { ...base, type: "freedraw", strokeWidth: mark.width / penWidthScale, points: localPoints(points),
    pressures: [], simulatePressure: true, lastCommittedPoint: null };
}

export function readMark(element: ExcalidrawElement, before?: Mark): { kind: DrawingKind; mark: Mark } | undefined {
  const { x, y, width, height, angle } = element;
  const color = element.strokeColor === palette.red ? "red" : element.strokeColor === palette.blue ? "blue"
    : before && "color" in before && before.color === "green" ? "green" : "slate";
  if (element.type === "text") {
    const text = element.originalText.trim();
    if (element.containerId || !text || text.includes("\0") || new TextEncoder().encode(text).length > 1024) return;
    return { kind: "labels", mark: { x: geometry(x), y: geometry(y + 17), text } };
  }
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const centerX = "points" in element ? (Math.max(...element.points.map(([px]) => px)) + Math.min(...element.points.map(([px]) => px))) / 2 : width / 2;
  const centerY = "points" in element ? (Math.max(...element.points.map(([, py]) => py)) + Math.min(...element.points.map(([, py]) => py))) / 2 : height / 2;
  const toBoard = ([px, py]: readonly [number, number]): Point => [
    geometry(x + centerX + (px - centerX) * cos - (py - centerY) * sin),
    geometry(y + centerY + (px - centerX) * sin + (py - centerY) * cos),
  ];
  if (element.type === "arrow") {
    if (element.points.length !== 2) return;
    const from = toBoard(element.points[0]);
    const to = toBoard(element.points[1]);
    if (from[0] === to[0] && from[1] === to[1]) return;
    return { kind: "arrows", mark: { from, to, color } };
  }
  let points: readonly (readonly [number, number])[];
  switch (element.type) {
    case "freedraw":
    case "line": points = element.points; break;
    case "rectangle":
    case "diamond":
    case "ellipse": points = outline(element.type, [width, height]); break;
    default: return;
  }
  if (!points.length) return;
  const [originX, originY] = toBoard([0, 0]);
  const steps = Math.max(2, Math.min(1024, points.length));
  const path = Array.from({ length: steps }, (_, index): Point => {
    const [px, py] = toBoard(points[Math.round(index * (points.length - 1) / (steps - 1))]);
    return [px - originX, py - originY];
  });
  return { kind: "strokes", mark: { id: before && "id" in before ? before.id : id(), x: originX, y: originY,
    points: path, color, width: Math.max(1, Math.min(12, element.strokeWidth * (element.type === "freedraw" ? penWidthScale : 1))) } };
}
