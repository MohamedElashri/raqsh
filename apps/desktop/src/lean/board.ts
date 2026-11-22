import type { Arrow, Card, Drawing, Edge, Id, Ink, Point, Stroke } from "../model";
import noteFontUrl from "./fonts/Excalifont-Regular.woff2?url";
import { getStrokeBounds, type Bounds } from "./geometry";

export type View = { x: number; y: number; zoom: number };
export type Board = Drawing & { nodes: Card[]; edges: Edge[] };

const cardFont = "15px system-ui";
const noteFontFamily = "Excalifont, system-ui, sans-serif";
const noteFontSize = 17;
const noteFont = `${noteFontSize}px ${noteFontFamily}`;
const noteLineHeight = 22;

const graphite = "#1b1b19";
const chalk = "#ededed";
const ink: Record<Ink, string> = { green: graphite, slate: graphite, blue: "#2862a3", red: "#a74a41" };
const darkInk: Record<Ink, string> = { green: chalk, slate: chalk, blue: "#94c5f0", red: "#ff9c91" };

const colors = { fill: "#e5e5e0", border: "#8c8981", edge: "#77746c", text: "#1b1b19", dropped: "#efeeea", paper: "#f0f0ed" };

function edgePoints(from: Card, to: Card): Point[] {
  const start: Point = [from.x + from.width, from.y + from.height / 2];
  const end: Point = [to.x, to.y + to.height / 2];
  return arrowPoints(start, end);
}

function arrowPoints(start: Point, end: Point): Point[] {
  const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
  const tip = (offset: number): Point => [end[0] - 12 * Math.cos(angle + offset), end[1] - 12 * Math.sin(angle + offset)];
  return [start, end, tip(0.45), end, tip(-0.45)];
}

type PathPainter = (points: readonly Point[], color: string, width: number, x: number, y: number) => void;

export type VisibleBoard = { region: Bounds; cards: ReadonlyMap<Id, Card>; strokes: WeakMap<Stroke, Bounds>; dark: boolean };

const overlaps = (box: Bounds, view: Bounds, padding: number) =>
  box.right + padding >= view.left && box.left - padding <= view.right
  && box.bottom + padding >= view.top && box.top - padding <= view.bottom;

function segmentVisible(x1: number, y1: number, x2: number, y2: number, region: Bounds) {
  return Math.max(x1, x2) + 14 >= region.left && Math.min(x1, x2) - 14 <= region.right
    && Math.max(y1, y2) + 14 >= region.top && Math.min(y1, y2) - 14 <= region.bottom;
}

function paths(board: Board, draw: PathPainter, visible?: VisibleBoard) {
  const byId = visible?.cards ?? new Map(board.nodes.map((node) => [node.id, node]));
  const palette = visible?.dark ? darkInk : ink;
  const edgeColor = visible?.dark ? "#b9b5ab" : colors.edge;
  for (const edge of board.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    if (visible && !segmentVisible(from.x + from.width, from.y + from.height / 2,
      to.x, to.y + to.height / 2, visible.region)) continue;
    draw(edgePoints(from, to), edgeColor, edge.kind === "dependency" ? 1.5 : 1, 0, 0);
  }
  for (const stroke of board.strokes) {
    if (!visible || overlaps(getStrokeBounds(stroke, visible.strokes), visible.region, stroke.width / 2 + 2)) {
      draw(stroke.points, palette[stroke.color], stroke.width, stroke.x, stroke.y);
    }
  }
  for (const arrow of board.arrows) {
    if (!visible || segmentVisible(arrow.from[0], arrow.from[1], arrow.to[0], arrow.to[1], visible.region)) {
      draw(arrowPoints(arrow.from, arrow.to), palette[arrow.color], 2, 0, 0);
    }
  }
}

export function paintPaths(
  context: CanvasRenderingContext2D, board: Board, draft?: Stroke | Arrow, visible?: VisibleBoard,
) {
  context.lineCap = "round";
  context.lineJoin = "round";
  const draw: PathPainter = (points, color, width, x, y) => {
    if (!points.length) return;
    context.beginPath();
    context.strokeStyle = color;
    context.lineWidth = width;
    context.moveTo(x + points[0][0], y + points[0][1]);
    for (let index = 1; index < points.length; index++) {
      context.lineTo(x + points[index][0], y + points[index][1]);
    }
    context.stroke();
  };
  paths(board, draw, visible);
  const palette = visible?.dark ? darkInk : ink;
  if (draft && "points" in draft) draw(draft.points, palette[draft.color], draft.width, draft.x, draft.y);
  else if (draft) draw(arrowPoints(draft.from, draft.to), palette[draft.color], 2, 0, 0);
}

const xml = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
  .replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);

function bounds(board: Board, context: CanvasRenderingContext2D) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const include = (x: number, y: number) => {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  };
  for (const node of board.nodes) {
    include(node.x, node.y);
    include(node.x + node.width, node.y + node.height);
  }
  paths(board, (points, _, width, x, y) => {
    for (const [px, py] of points) {
      include(x + px - width / 2, y + py - width / 2);
      include(x + px + width / 2, y + py + width / 2);
    }
  });
  for (const label of board.labels) {
    for (const [row, text] of label.text.split("\n").entries()) {
      const width = context.measureText(text).width;
      const y = label.y + noteLineHeight * row;
      include(label.x, y - noteFontSize);
      include(label.x + (rtl(text) ? -width : width), y + 6);
    }
  }
  if (left === Infinity) include(0, 0);
  return { x: left - 18, y: top - 18, width: right - left + 36, height: bottom - top + 36 };
}

function rtl(text: string) {
  const firstLetter = text.match(/\p{Letter}/u)?.[0];
  return firstLetter !== undefined && /[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(firstLetter);
}

function lines(context: CanvasRenderingContext2D, text: string, width: number) {
  return text.split("\n").flatMap((paragraph) => {
    const wrapped: string[] = [];
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const joined = line ? `${line} ${word}` : word;
      if (line && context.measureText(joined).width > width) {
        wrapped.push(line);
        line = word;
      } else line = joined;
    }
    wrapped.push(line);
    return wrapped;
  });
}

async function svgNoteFont() {
  const response = await fetch(noteFontUrl);
  if (!response.ok) throw new Error("Could not load the board font");
  const font = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(`<style>@font-face{font-family:Excalifont;src:url(${reader.result}) format("woff2")}</style>`);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(font.slice(0, font.size, "font/woff2"));
  });
}

export async function exportImage(board: Board, format: "png" | "svg"): Promise<Blob> {
  if (board.labels.length) await document.fonts.load(noteFont);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d")!;
  context.font = noteFont;
  const region = bounds(board, context);
  const scale = Math.min(1, 4096 / Math.max(region.width, region.height));
  if (format === "png") {
    canvas.width = Math.ceil(region.width * scale);
    canvas.height = Math.ceil(region.height * scale);
  }
  context.font = cardFont;
  const cardLines = board.nodes.map((node) => lines(context, node.title, node.width - 24));
  if (format === "svg") {
    const geometry: string[] = [];
    paths(board, (points, color, width, x, y) => geometry.push(`<polyline points="${points.map(([px, py]) => `${px + x},${py + y}`).join(" ")}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`));
    const label = (x: number, y: number, text: string, align: "middle" | "start") => {
      const note = align === "start" ? ` font-family="${noteFontFamily}" font-size="${noteFontSize}"` : "";
      return `<text x="${x}" y="${y}" text-anchor="${align}" direction="${rtl(text) ? "rtl" : "ltr"}" unicode-bidi="embed"${note}>${xml(text)}</text>`;
    };
    for (const [index, node] of board.nodes.entries()) {
      const fill = node.dropped ? colors.dropped : colors.fill;
      geometry.push(`<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="4" fill="${fill}" stroke="${colors.border}"/>`,
        `<clipPath id="card-${index}"><rect x="${node.x + 4}" y="${node.y + 2}" width="${node.width - 8}" height="${node.height - 4}"/></clipPath><g clip-path="url(#card-${index})">`);
      const rows = cardLines[index];
      for (const [row, text] of rows.entries()) geometry.push(label(node.x + node.width / 2, node.y + node.height / 2 + (row - (rows.length - 1) / 2) * 18 + 5, text, "middle"));
      geometry.push("</g>");
    }
    for (const item of board.labels) {
      for (const [row, text] of item.text.split("\n").entries()) geometry.push(label(item.x, item.y + noteLineHeight * row, text, "start"));
    }
    const font = board.labels.length ? await svgNoteFont() : "";
    return new Blob([`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${region.x} ${region.y} ${region.width} ${region.height}" font-family="system-ui" font-size="15" fill="${colors.text}">${font}${geometry.join("")}</svg>`], { type: "image/svg+xml" });
  }
  context.scale(scale, scale);
  context.translate(-region.x, -region.y);
  context.fillStyle = colors.paper;
  context.fillRect(region.x, region.y, region.width, region.height);
  paintPaths(context, board);
  for (const [index, node] of board.nodes.entries()) {
    context.fillStyle = node.dropped ? colors.dropped : colors.fill;
    context.fillRect(node.x, node.y, node.width, node.height);
    context.strokeStyle = colors.border;
    context.lineWidth = 1;
    context.strokeRect(node.x, node.y, node.width, node.height);
    context.fillStyle = colors.text;
    context.save();
    context.beginPath();
    context.rect(node.x + 4, node.y + 2, node.width - 8, node.height - 4);
    context.clip();
    context.textAlign = "center";
    const rows = cardLines[index];
    for (const [row, text] of rows.entries()) {
      context.direction = rtl(text) ? "rtl" : "ltr";
      context.fillText(text, node.x + node.width / 2, node.y + node.height / 2 + (row - (rows.length - 1) / 2) * 18 + 5);
    }
    context.restore();
  }
  context.font = noteFont;
  context.fillStyle = colors.text;
  context.textAlign = "start";
  for (const label of board.labels) {
    for (const [row, text] of label.text.split("\n").entries()) {
      context.direction = rtl(text) ? "rtl" : "ltr";
      context.fillText(text, label.x, label.y + noteLineHeight * row);
    }
  }
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not encode PNG"))));
}
