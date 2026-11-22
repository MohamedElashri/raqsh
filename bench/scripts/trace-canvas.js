const frames = [];
const responses = [];
let entered;
let finished;
let lastFrame;
let input;
let painted = false;
let moves = 0;
let canvasClears = 0;
let pathsStroked = 0;
let rendering = requestAnimationFrame(frame);
const context = CanvasRenderingContext2D.prototype;
const measuredCanvases = new Set(document.querySelectorAll(".board-editor canvas:not(.interactive), .board-editor canvas[data-board-surface]"));
const methods = ["clearRect", "fillRect", "stroke", "drawImage"];
const originals = methods.map((name) => [name, context[name]]);

function frame(timestamp) {
  if (entered !== undefined && finished === undefined) {
    if (lastFrame !== undefined) frames.push(timestamp - lastFrame);
    lastFrame = timestamp;
    if (painted && input !== undefined) {
      responses.push(Math.max(0, performance.now() - input));
      input = undefined;
      painted = false;
    }
  }
  rendering = requestAnimationFrame(frame);
}

function press(event) {
  if (event.isTrusted && event.target.matches(".board-editor canvas.interactive")) entered = performance.now();
}

function pointer(event) {
  if (event.isTrusted && entered !== undefined && finished === undefined) {
    input = performance.now();
    painted = false;
    moves++;
  }
}

function release() {
  finished = performance.now();
}

for (const [name, original] of originals) {
  context[name] = function (...args) {
    const result = original.apply(this, args);
    if (entered !== undefined && finished === undefined && measuredCanvases.has(this.canvas)) {
      if (name === "clearRect") canvasClears++;
      if (name === "stroke") pathsStroked++;
      if (input !== undefined) painted = true;
    }
    return result;
  };
}

window.addEventListener("pointerdown", press, true);
window.addEventListener("pointermove", pointer, true);
window.addEventListener("pointerup", release, true);
window.finishCanvasTrace = () => {
  cancelAnimationFrame(rendering);
  for (const [name, original] of originals) context[name] = original;
  window.removeEventListener("pointerdown", press, true);
  window.removeEventListener("pointermove", pointer, true);
  window.removeEventListener("pointerup", release, true);
  delete window.finishCanvasTrace;
  return { elapsed_ms: finished - entered, pointer_moves: moves, frame_intervals_ms: frames, paint_responses_ms: responses,
    canvas_clears: canvasClears, paths_stroked: pathsStroked };
};
