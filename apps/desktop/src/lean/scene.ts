import { convertToExcalidrawElements, exportToBlob, exportToSvg, FONT_FAMILY } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, ExcalidrawFreeDrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { Card, Drawing, Edge, ExcalidrawScene, Ink, Point } from "../model";
import { drawingKinds, type Mark } from "./editing";
import { outline, type Shape } from "./geometry";

const palette: Record<Ink, string> = { green: "#1b1b19", slate: "#1b1b19", blue: "#2862a3", red: "#a74a41" };
const stroke = { roughness: 0, strokeWidth: 2, roundness: null, strokeColor: palette.slate } as const;
// Perfect Freehand's outline is wider than the legacy line width at the same numeric value.
export const penWidthScale = 3;
const exact = { regenerateIds: false };
const localPoints = (points: Point[]) => points as unknown as ExcalidrawFreeDrawElement["points"];
export const cardId = (key: string) => `raqsh-card-${key}`;
export const edgeId = (key: string) => `raqsh-edge-${key}`;

export function cardElements(cards: Card[], edges: Edge[], visible = false) {
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
        customData: { raqshEdge: edge.id }, strokeColor: "#77746c", strokeWidth: edge.kind === "dependency" ? 1.5 : 1 }];
    }),
    ...cards.map((card) => ({
      ...stroke, type: "rectangle" as const, id: cardId(card.id), x: card.x, y: card.y,
      width: card.width, height: card.height, customData: { raqshCard: card.id },
      opacity: visible ? 100 : 0, backgroundColor: card.dropped ? "#efeeea" : "#e5e5e0",
      strokeColor: "#8c8981", strokeWidth: 1, fillStyle: "solid" as const,
      label: visible ? { text: card.title, fontSize: 17, fontFamily: FONT_FAMILY.Nunito } : undefined,
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
  const width = Math.max(...points.map(([px]) => px)) - Math.min(...points.map(([px]) => px));
  const height = Math.max(...points.map(([, py]) => py)) - Math.min(...points.map(([, py]) => py));
  // A native line keeps the vertices and endpoints of a legacy stroke.
  // Freehand smoothing can shorten a stroke with widely spaced points.
  if (width || height) {
    return convertToExcalidrawElements([{ ...style, type: "line", x: mark.x + x, y: mark.y + y,
      width, height, points: localPoints(points) }], exact)[0];
  }
  const [base] = convertToExcalidrawElements([{ ...style, type: "rectangle", x: mark.x + x, y: mark.y + y,
    width, height }], exact);
  return { ...base, type: "freedraw", strokeWidth: mark.width / penWidthScale, points: localPoints(points),
    pressures: [], simulatePressure: true, lastCommittedPoint: null };
}

export const isTypedId = (id: string) => id.startsWith("raqsh-card-") || id.startsWith("raqsh-edge-");

export function openScene(drawing: Drawing): ExcalidrawScene {
  return drawing.excalidraw ?? {
    version: 1, files: {}, background: "transparent", gridSize: null,
    elements: drawingKinds.flatMap((kind) => drawing[kind].map((item, index) =>
      markElement(item, `drawing-${kind}-${index}`))),
  };
}

export function sceneAppState(scene: ExcalidrawScene) {
  return { viewBackgroundColor: scene.background, gridModeEnabled: scene.gridSize !== null,
    gridSize: scene.gridSize ?? 20 };
}

export function composeScene(typed: readonly ExcalidrawElement[], scene: ExcalidrawScene) {
  const byCard = new Map<string, Set<string>>();
  for (const element of scene.elements) {
    if (element.type !== "arrow") continue;
    for (const binding of [element.startBinding, element.endBinding]) {
      const id = binding?.elementId;
      if (!id?.startsWith("raqsh-card-")) continue;
      if (!byCard.has(id)) byCard.set(id, new Set());
      byCard.get(id)!.add(element.id);
    }
  }
  return [...typed.map((element) => {
    const arrows = byCard.get(element.id);
    return arrows ? { ...element, boundElements: [...(element.boundElements ?? []),
      ...Array.from(arrows, (id) => ({ id, type: "arrow" as const }))] } : element;
  }), ...scene.elements];
}

// Excalidraw mutates its own elements during gestures. Reuse immutable snapshots
// across undo entries, cloning only elements whose native version changed.
export function snapshotScene(
  previous: ExcalidrawScene, elements: readonly ExcalidrawElement[], files: BinaryFiles, state: AppState,
): ExcalidrawScene {
  const background = state.viewBackgroundColor;
  const gridSize = state.gridModeEnabled ? state.gridSize : null;
  const native = elements.filter((element) => !isTypedId(element.id) &&
    !element.customData?.raqshCard && !element.customData?.raqshEdge && !element.isDeleted);
  const images: BinaryFiles = {};
  for (const element of native) {
    if (element.type === "image" && element.fileId && files[element.fileId]) {
      images[element.fileId] = files[element.fileId];
    }
  }
  const unchanged = native.length === previous.elements.length && native.every((element, index) => {
    const saved = previous.elements[index];
    return saved.id === element.id && saved.versionNonce === element.versionNonce;
  });
  if (unchanged && background === previous.background && gridSize === previous.gridSize &&
    Object.keys(images).length === Object.keys(previous.files).length &&
    Object.keys(images).every((id) => images[id].dataURL === previous.files[id]?.dataURL)) return previous;
  const saved = new Map(previous.elements.map((element) => [element.id, element]));
  return {
    version: 1, background, gridSize, files: images,
    elements: native.map((element) => saved.get(element.id)?.versionNonce === element.versionNonce
      ? saved.get(element.id)! : structuredClone(element)),
  };
}

export async function exportScene(cards: Card[], edges: Edge[], scene: ExcalidrawScene, format: "png" | "svg") {
  const opts = {
    elements: composeScene(cardElements(cards, edges, true), scene),
    appState: { ...sceneAppState(scene), exportBackground: scene.background !== "transparent" },
    files: scene.files,
  };
  if (format === "png") return exportToBlob({ ...opts, mimeType: "image/png",
    getDimensions: (width: number, height: number) => {
      const scale = Math.min(1, 4096 / Math.max(width, height, 1));
      return { width: Math.ceil(width * scale), height: Math.ceil(height * scale), scale };
    } });
  const svg = await exportToSvg(opts);
  return new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
}
