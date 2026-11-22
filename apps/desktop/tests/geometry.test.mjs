import assert from "node:assert/strict";
import { test } from "node:test";
import { getStrokeBounds, nearPath, nearStroke, outline } from "../src/lean/geometry.ts";

test("stroke bounds cover translated and negative points", () => {
  const stroke = { x: -35, y: 63, points: [[14, 3], [-12, -25], [6, 8]] };
  assert.deepEqual(getStrokeBounds(stroke, new WeakMap()), { left: -47, top: 38, right: -21, bottom: 71 });
});

test("eraser includes the painted width and the rounded endpoints", () => {
  const stroke = { x: -50, y: 80, width: 4, points: [[-10, 0], [10, 0]] };
  const cache = new WeakMap();
  assert.equal(nearStroke(stroke, -63, 80, 1, cache), true);
  assert.equal(nearStroke(stroke, -50, 83, 1, cache), true);
  assert.equal(nearStroke(stroke, -63, 83, 1, cache), false);
  assert.equal(nearStroke(stroke, -50, 83.01, 1, cache), false);
});

test("bounding-box rejection preserves segment-level erasing for shapes and repeated points", () => {
  const paths = [outline("ellipse", [-10, 12]), outline("diamond", [16, -8]), [[0, 0], [0, 0]]];
  const cache = new WeakMap();
  for (const points of paths) {
    const stroke = { x: 130, y: -40, width: 3, points };
    for (const radius of [0, 3, 20]) {
      for (let dx = -25; dx < 25; dx++) {
        for (let dy = -25; dy < 25; dy++) {
          assert.equal(nearStroke(stroke, stroke.x + dx, stroke.y + dy, radius, cache),
            nearPath(points, dx, dy, radius + stroke.width / 2), `offset ${dx},${dy} at radius ${radius}`);
        }
      }
    }
  }
});
