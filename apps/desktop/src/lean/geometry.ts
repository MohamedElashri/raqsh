import type { Point, Stroke } from "../model";

export type Shape = "rectangle" | "diamond" | "ellipse" | "line";
export type Bounds = { left: number; top: number; right: number; bottom: number };

export function getStrokeBounds(stroke: Stroke, cache: WeakMap<Stroke, Bounds>): Bounds {
  let box = cache.get(stroke);
  if (!box) {
    box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const [dx, dy] of stroke.points) {
      const x = stroke.x + dx;
      const y = stroke.y + dy;
      box.left = Math.min(box.left, x);
      box.top = Math.min(box.top, y);
      box.right = Math.max(box.right, x);
      box.bottom = Math.max(box.bottom, y);
    }
    cache.set(stroke, box);
  }
  return box;
}

export function nearStroke(stroke: Stroke, x: number, y: number, radius: number, cache: WeakMap<Stroke, Bounds>) {
  const bounds = getStrokeBounds(stroke, cache);
  const padding = radius + stroke.width / 2;
  return x >= bounds.left - padding && x <= bounds.right + padding
    && y >= bounds.top - padding && y <= bounds.bottom + padding
    && nearPath(stroke.points, x - stroke.x, y - stroke.y, padding);
}

export function insideClosedStroke(stroke: Stroke, x: number, y: number, cache: WeakMap<Stroke, Bounds>) {
  if (stroke.points.length < 4) return false;
  const first = stroke.points[0];
  const last = stroke.points.at(-1)!;
  if (Math.abs(first[0] - last[0]) + Math.abs(first[1] - last[1]) > 0.01) return false;
  const box = getStrokeBounds(stroke, cache);
  if (x < box.left || x > box.right || y < box.top || y > box.bottom) return false;
  const px = x - stroke.x;
  const py = y - stroke.y;
  let inside = false;
  for (let index = 1; index < stroke.points.length; index++) {
    const [ax, ay] = stroke.points[index - 1];
    const [bx, by] = stroke.points[index];
    if ((ay > py) !== (by > py) && px < ax + (bx - ax) * (py - ay) / (by - ay)) inside = !inside;
  }
  return inside;
}

export function outline(shape: Shape, [width, height]: Point): Point[] {
  switch (shape) {
    case "line":
      return [[0, 0], [width, height]];
    case "rectangle":
      return [[0, 0], [width, 0], [width, height], [0, height], [0, 0]];
    case "diamond":
      return [[width / 2, 0], [width, height / 2], [width / 2, height], [0, height / 2], [width / 2, 0]];
    case "ellipse":
      return Array.from({ length: 49 }, (_, index): Point => {
        const angle = index * Math.PI / 24;
        return [width * (1 + Math.cos(angle)) / 2, height * (1 + Math.sin(angle)) / 2];
      });
  }
}

export function nearPath(points: readonly Point[], x: number, y: number, radius: number): boolean {
  for (let index = 1; index < points.length; index++) {
    const [ax, ay] = points[index - 1];
    const [bx, by] = points[index];
    const vx = bx - ax;
    const vy = by - ay;
    const length = vx * vx + vy * vy;
    const t = length ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / length)) : 0;
    if ((x - ax - t * vx) ** 2 + (y - ay - t * vy) ** 2 <= radius ** 2) return true;
  }
  return false;
}
