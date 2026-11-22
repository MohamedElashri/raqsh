import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MutableRefObject, type PointerEvent } from "react";
import { id, kinds, makeCard, priorities, statuses, type Arrow, type Card, type Change, type Id, type Ink, type Label, type OpenBoard,
  type Operation, type Point, type Receipt, type Stroke } from "../model";
import { arrowPoints, edgePoints, exportImage, paintPaths, type Board, type View } from "./board";
import { Checkpoint, type SaveState } from "./checkpoint";
import { getStrokeBounds, insideClosedStroke, nearPath, nearStroke, outline, type Bounds, type Shape } from "./geometry";
import { applyMarks, boundedOffset, boxBetween, cardBounds, drawingKinds, duplicateSelection, emptySelection, geometry,
  includesPoint, invertMarks, movableBounds, removeSelection, selectedTarget, selectionSize, toggleTarget, topmost, translateMark, within,
  type BoardEdit, type DrawingKind, type Mark, type MarkChange, type Selection, type Target } from "./editing";
import AgentPanel from "./AgentPanel";
import { brand } from "../generated/brand";
import { Icon } from "../Icon";
import { Modal } from "../Modal";
import "../editor.css";
import "./lean.css";

type Tool = "select" | "pan" | "pen" | "text" | "arrow" | "connect" | "eraser" | Shape;
type Gesture =
  | { kind: "pan"; start: Point; view: View }
  | { kind: "move"; start: Point; cards: Card[]; bounds: Bounds; offset: Point }
  | { kind: "resize"; start: Point; card: Card; preview: Card }
  | { kind: "resize-mark"; mark: Stroke | Arrow; box: Bounds; start: Point; preview: Stroke | Arrow; end?: "from" | "to" }
  | { kind: "box"; start: Point; end: Point; extend: boolean }
  | { kind: "text"; at: Point }
  | { kind: "pen"; stroke: Stroke }
  | { kind: "shape"; shape: Shape; stroke: Stroke }
  | { kind: "eraser"; removed: Set<Mark> }
  | { kind: "arrow"; arrow: Arrow };
type Edit = { kind: "card"; card: Card; fresh: boolean } | { kind: "text"; point: Point; label?: Label };
type Delta = Pick<Receipt, "revision" | "changes">;
type DeltaPage = { revision: number; deltas: Delta[]; nextRevision: number };
type HistoryAction = "record" | "undo" | "redo";
type Submission = { operation: Operation; marks: MarkChange[]; history: HistoryAction; selection?: Selection };
type Props = {
  opened: OpenBoard;
  registerClose: MutableRefObject<((windowClose: boolean) => void) | undefined>;
  onClose: () => void;
};

const tools: { id: Tool | "image"; label: string; key?: string; number?: string }[] = [
  { id: "pan", label: "Hand", key: "h" },
  { id: "select", label: "Selection", key: "v", number: "1" },
  { id: "rectangle", label: "Rectangle", key: "r", number: "2" },
  { id: "diamond", label: "Diamond", key: "d", number: "3" },
  { id: "ellipse", label: "Ellipse", key: "o", number: "4" },
  { id: "arrow", label: "Arrow", key: "a", number: "5" },
  { id: "line", label: "Line", key: "l", number: "6" },
  { id: "pen", label: "Draw", key: "p", number: "7" },
  { id: "text", label: "Text", key: "t", number: "8" },
  { id: "image", label: "Image attachments unavailable", number: "9" },
  { id: "eraser", label: "Eraser", key: "e", number: "0" },
];
const noOffset: Point = [0, 0];
const inkChoices: Partial<Record<Ink, string>> = { slate: "Graphite", blue: "Blue", red: "Red" };
const ordered = (a: Card, b: Card) => a.order - b.order || a.id.localeCompare(b.id);
const setNode = (node: Card): Change => ({ type: "setNode", node });
const choices = (values: Record<string, string>) => Object.entries(values).map(([value, label]) => (
  <option key={value} value={value}>{label}</option>
));

function deadline<T>(task: Promise<T>, timeout: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Board storage is still responding. Try again.")), timeout);
    void task.then(resolve, reject).finally(() => window.clearTimeout(timer));
  });
}

export default function LeanEditor({ opened, registerClose, onClose }: Props) {
  const { scope, board: info, drawing } = opened;
  const [board] = useState<Board>(() => ({ ...drawing, nodes: opened.nodes.sort(ordered), edges: opened.edges }));
  const [nodeIndex] = useState(() => new Map(board.nodes.map((node) => [node.id, node])));
  const [strokeBounds] = useState(() => new WeakMap<Stroke, Bounds>());
  const [tool, setTool] = useState<Tool>("select");
  const [keepTool, setKeepTool] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [selection, setSelection] = useState(emptySelection);
  const [edit, setEdit] = useState<Edit>();
  const [inspector, setInspector] = useState(false);
  const [agents, setAgents] = useState(false);
  const [keyboardHelp, setKeyboardHelp] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({
    message: `Drawing checkpoint ${info.drawingRevision}`,
    failed: false,
  });
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [closeFailure, setCloseFailure] = useState<{ windowClose: boolean; message: string }>();
  const [, refresh] = useState(0);
  const update = () => refresh((value) => value + 1);

  const panel = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const moreTools = useRef<HTMLDetailsElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cardsLayer = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<Id, HTMLDivElement>());
  const labels = useRef(new Map<Label, HTMLSpanElement>());
  const movedStrokes = useRef(new Map<Stroke, Stroke>());
  const movedArrows = useRef(new Map<Arrow, Arrow>());
  const list = useRef<HTMLOListElement>(null);
  const listToggle = useRef<HTMLButtonElement>(null);
  const agentsToggle = useRef<HTMLButtonElement>(null);
  const selectionRef = useRef(selection);
  const focusedCard = useRef<Id>();
  const gesture = useRef<Gesture>();
  const view = useRef<View>({ x: 0, y: 0, zoom: 1 });
  const revision = useRef(info.semanticRevision);
  const undoHistory = useRef<BoardEdit[]>([]);
  const redoHistory = useRef<BoardEdit[]>([]);
  const [initialPointCount] = useState(() => drawing.strokes.reduce((total, stroke) => total + stroke.points.length, 0));
  const points = useRef(initialPointCount);
  const semantic = useRef<Promise<void>>();
  const failed = useRef<Submission>();
  const dependency = useRef<Id>();
  const latestClose = useRef<(windowClose: boolean) => void>();
  const locked = useRef(false);
  const draftChanged = useRef(false);
  const editAnchor = useRef<HTMLElement>();
  const space = useRef(false);
  const frame = useRef(0);
  const remoteTimer = useRef(0);
  const remoteNeeded = useRef(false);
  const remoteBusy = useRef(false);
  const mounted = useRef(false);
  const remoteRefresh = useRef<() => void>();
  const [saver] = useState(() => new Checkpoint(scope, info.drawingRevision, drawing, setSaveState));
  const [darkMode] = useState(() => window.matchMedia("(prefers-color-scheme: dark)"));

  const repaint = useCallback(() => {
    if (frame.current || document.hidden) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const surface = canvas.current;
      if (!surface || !cardsLayer.current) return;
      const ratio = window.devicePixelRatio;
      const cssWidth = surface.clientWidth;
      const cssHeight = surface.clientHeight;
      const width = Math.round(cssWidth * ratio);
      const height = Math.round(cssHeight * ratio);
      if (surface.width !== width) surface.width = width;
      if (surface.height !== height) surface.height = height;
      const context = surface.getContext("2d")!;
      const camera = view.current;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      context.setTransform(ratio * camera.zoom, 0, 0, ratio * camera.zoom, ratio * camera.x, ratio * camera.y);
      const active = gesture.current;
      const draft = active?.kind === "pen" || active?.kind === "shape" ? active.stroke : active?.kind === "arrow" ? active.arrow : undefined;
      paintPaths(context, board, draft, {
        cards: nodeIndex, strokes: strokeBounds, dark: darkMode.matches,
        movedStrokes: movedStrokes.current, movedArrows: movedArrows.current, region: {
          left: -camera.x / camera.zoom, top: -camera.y / camera.zoom,
          right: (cssWidth - camera.x) / camera.zoom, bottom: (cssHeight - camera.y) / camera.zoom,
        },
      });
      const picked = selectionRef.current;
      const handles = selectionSize(picked) === 1;
      const focus = darkMode.matches ? "#f0bf69" : "#9c631b";
      const handleSize = 7 / camera.zoom;
      const drawHandle = ([x, y]: Point) => {
        context.fillStyle = focus;
        context.fillRect(x - handleSize / 2, y - handleSize / 2, handleSize, handleSize);
      };
      context.strokeStyle = focus;
      context.lineWidth = 1.5 / camera.zoom;
      if (picked.edges.size) {
        for (const edge of board.edges) {
          if (!picked.edges.has(edge.id)) continue;
          const from = nodeIndex.get(edge.from);
          const to = nodeIndex.get(edge.to);
          if (!from || !to) continue;
          const [start, ...path] = edgePoints(from, to);
          context.beginPath();
          context.moveTo(...start);
          for (const point of path) context.lineTo(...point);
          context.stroke();
        }
      }
      context.setLineDash([4 / camera.zoom, 3 / camera.zoom]);
      for (const mark of picked.marks) {
        if ("points" in mark) {
          const box = getStrokeBounds(movedStrokes.current.get(mark) ?? mark, strokeBounds);
          context.strokeRect(box.left - 3, box.top - 3, box.right - box.left + 6, box.bottom - box.top + 6);
          if (handles) drawHandle([box.right, box.bottom]);
        } else if ("from" in mark) {
          const arrow = movedArrows.current.get(mark) ?? mark;
          context.beginPath();
          context.moveTo(...arrow.from);
          context.lineTo(...arrow.to);
          context.stroke();
          if (handles) {
            drawHandle(arrow.from);
            drawHandle(arrow.to);
          }
        }
      }
      if (active?.kind === "box") {
        const box = boxBetween(active.start, active.end);
        context.strokeRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
      }
      context.setLineDash([]);
      const transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`;
      if (cardsLayer.current.style.transform !== transform) cardsLayer.current.style.transform = transform;
      if (panel.current && !panel.current.dataset.editorReady) panel.current.dataset.editorReady = "true";
    });
  }, [board, nodeIndex, strokeBounds, darkMode]);

  useEffect(() => {
    const observer = new ResizeObserver(repaint);
    if (canvas.current) observer.observe(canvas.current);
    canvas.current?.focus({ preventScroll: true });
    repaint();
    const release = () => { space.current = false; };
    const flushHidden = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        if (!locked.current) void saver.flush().catch(() => {});
      } else repaint();
    };
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", flushHidden);
    darkMode.addEventListener("change", repaint);
    registerClose.current = (windowClose) => latestClose.current?.(windowClose);
    return () => {
      registerClose.current = undefined;
      observer.disconnect();
      cancelAnimationFrame(frame.current);
      saver.dispose();
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", flushHidden);
      darkMode.removeEventListener("change", repaint);
    };
  }, [registerClose, repaint, saver, darkMode]);

  useEffect(() => {
    mounted.current = true;
    const subscription = listen<[OpenBoard["scope"], number]>("board-remote-revision", ({ payload }) => {
      const [owner, next] = payload;
      if (owner.instance === scope.instance && next > revision.current) scheduleRemote();
    });
    void subscription.then(() => {
      if (mounted.current) scheduleRemote();
    }).catch((error) => setNotice(String(error)));
    return () => {
      mounted.current = false;
      clearTimeout(remoteTimer.current);
      void subscription.then((stop) => stop()).catch(() => {});
    };
  }, [scope]);

  function scheduleRemote() {
    remoteNeeded.current = true;
    if (!mounted.current || remoteTimer.current || remoteBusy.current || gesture.current || semantic.current
      || failed.current || locked.current || edit) return;
    remoteTimer.current = window.setTimeout(() => {
      remoteTimer.current = 0;
      remoteRefresh.current?.();
    }, 30);
  }

  remoteRefresh.current = () => {
    if (!mounted.current || !remoteNeeded.current || remoteBusy.current || gesture.current || semantic.current
      || failed.current || locked.current || edit) return;
    remoteNeeded.current = false;
    remoteBusy.current = true;
    void invoke<DeltaPage>("board_deltas", { scope, since: revision.current })
      .then((page) => {
        if (!mounted.current) return;
        const changes = page.deltas.filter((delta) => delta.revision > revision.current);
        if (changes.length) {
          project(changes);
          const retainDrawing = (stack: BoardEdit[]) => stack.filter((entry) => entry.marks.length)
            .map((entry) => ({ ...entry, changes: [] }));
          undoHistory.current = retainDrawing(undoHistory.current);
          redoHistory.current = retainDrawing(redoHistory.current);
          if (!failed.current) setNotice(`Paired client update · revision ${revision.current}`);
        }
        if (page.nextRevision < page.revision) remoteNeeded.current = true;
      }).catch((error) => {
        if (mounted.current) setNotice(String(error));
      }).finally(() => {
        remoteBusy.current = false;
        if (remoteNeeded.current) scheduleRemote();
      });
  };

  useEffect(() => {
    if (!edit && remoteNeeded.current) scheduleRemote();
  }, [edit]);

  function showCard(card: Card) {
    const button = cards.current.get(card.id);
    if (button) {
      button.style.left = `${card.x}px`;
      button.style.top = `${card.y}px`;
      button.style.width = `${card.width}px`;
      button.style.height = `${card.height}px`;
    }
  }

  function project(deltas: Delta[]) {
    let geometryChanged = false;
    const picked = selectionRef.current;
    let pruned: Selection | undefined;
    for (const delta of deltas) {
      for (const change of delta.changes) {
        switch (change.type) {
          case "setNode": {
            const index = board.nodes.findIndex((node) => node.id === change.node.id);
            const previous = board.nodes[index];
            const node = change.node;
            if (!previous || previous.x !== node.x || previous.y !== node.y
              || previous.width !== node.width || previous.height !== node.height) {
              geometryChanged = true;
              showCard(node);
            }
            if (index < 0) board.nodes.push(node);
            else board.nodes[index] = node;
            nodeIndex.set(node.id, node);
            break;
          }
          case "removeNode": {
            const index = board.nodes.findIndex((node) => node.id === change.id);
            if (index >= 0) board.nodes.splice(index, 1);
            nodeIndex.delete(change.id);
            if (picked.cards.has(change.id)) {
              pruned ??= { ...picked, cards: new Set(picked.cards), edges: new Set(picked.edges) };
              pruned.cards.delete(change.id);
            }
            geometryChanged = true;
            break;
          }
          case "setEdge": {
            const index = board.edges.findIndex((edge) => edge.id === change.edge.id);
            if (index < 0) board.edges.push(change.edge);
            else board.edges[index] = change.edge;
            geometryChanged = true;
            break;
          }
          case "removeEdge": {
            const index = board.edges.findIndex((edge) => edge.id === change.id);
            if (index >= 0) board.edges.splice(index, 1);
            if (picked.edges.has(change.id)) {
              pruned ??= { ...picked, cards: new Set(picked.cards), edges: new Set(picked.edges) };
              pruned.edges.delete(change.id);
            }
            geometryChanged = true;
            break;
          }
        }
      }
      revision.current = delta.revision;
    }
    if (pruned) chooseSelection(pruned);
    board.nodes.sort(ordered);
    update();
    if (geometryChanged) repaint();
  }

  function chooseSelection(next: Selection) {
    selectionRef.current = next;
    if (next.cards.size === 1) focusedCard.current = next.cards.values().next().value;
    setSelection(next);
    repaint();
  }

  function send(submission: Submission) {
    failed.current = undefined;
    setNotice("Saving board changes…");
    semantic.current = invoke<Receipt>("apply_operation", { scope, operation: submission.operation })
      .then((receipt) => {
        project([receipt]);
        finishEdit(submission.marks, receipt.inverse, submission.history, submission.selection);
        setNotice(`Saved · revision ${receipt.revision}`);
      })
      .catch((error) => {
        failed.current = submission;
        setNotice(String(error));
      })
      .finally(() => {
        semantic.current = undefined;
        update();
        if (remoteNeeded.current) scheduleRemote();
      });
  }

  function canEdit() {
    return !locked.current && !semantic.current && !failed.current && !remoteBusy.current;
  }

  function commit(changes: Change[], marks: MarkChange[] = [], history: HistoryAction = "record", selected?: Selection) {
    if (!canEdit() || (!changes.length && !marks.length)) return false;
    if (changes.length > 64) {
      setNotice("This edit affects more than 64 cards or links. Select fewer objects and try again.");
      return false;
    }
    if (changes.length) {
      send({ operation: { id: id(), expectedRevision: revision.current, changes }, marks, history, selection: selected });
    } else {
      finishEdit(marks, [], history, selected);
    }
    return true;
  }

  function finishEdit(marks: MarkChange[], inverse: Change[], history: HistoryAction, selected?: Selection) {
    if (marks.length) {
      points.current += applyMarks(drawing, marks);
      const current = selectionRef.current;
      const next = new Set(current.marks);
      for (const { before, after } of marks) {
        if (before && next.delete(before) && after) next.add(after);
      }
      if (!selected && current.marks.size) chooseSelection({ ...current, marks: next });
      saver.changed();
      repaint();
    }
    if (selected) chooseSelection(selected);
    const entry = { changes: inverse, marks: invertMarks(marks) };
    if (history === "undo") {
      undoHistory.current.pop();
      redoHistory.current.push(entry);
    } else {
      if (history === "redo") redoHistory.current.pop();
      else redoHistory.current = [];
      undoHistory.current.push(entry);
      if (undoHistory.current.length > 32) undoHistory.current.shift();
    }
    update();
  }

  function changeHistory(redo = false) {
    if (gesture.current || edit) return;
    const entry = (redo ? redoHistory : undoHistory).current.at(-1);
    if (entry) commit(entry.changes, entry.marks, redo ? "redo" : "undo");
  }

  function addMark<K extends DrawingKind>(kind: K, mark: Board[K][number]) {
    return commit([], [{ kind, index: drawing[kind].length, after: mark }]);
  }

  function eraseAt(event: PointerEvent<HTMLCanvasElement>, removed: Set<Mark>) {
    const [x, y] = point(event);
    const radius = 6 / view.current.zoom;
    for (const stroke of drawing.strokes) {
      if (!removed.has(stroke) && nearStroke(stroke, x, y, radius, strokeBounds)) {
        removed.add(stroke);
      }
    }
    for (const arrow of drawing.arrows) {
      if (nearPath([arrow.from, arrow.to], x, y, radius)) removed.add(arrow);
    }
    cardsLayer.current?.querySelectorAll(".lean-label").forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
        removed.add(drawing.labels[index]);
      }
    });
  }

  function point(event: PointerEvent<HTMLCanvasElement>, convert = true): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    const position: Point = [event.clientX - rect.left, event.clientY - rect.top];
    const camera = view.current;
    return convert ? [geometry((position[0] - camera.x) / camera.zoom), geometry((position[1] - camera.y) / camera.zoom)] : position;
  }

  function hit([x, y]: Point) {
    for (let index = board.nodes.length - 1; index >= 0; index--) {
      const card = board.nodes[index];
      if (x >= card.x && x <= card.x + card.width && y >= card.y && y <= card.y + card.height) return card;
    }
  }

  function labelBounds(label: Label): Bounds {
    const element = labels.current.get(label);
    return { left: label.x, top: label.y - 17, right: label.x + (element?.offsetWidth ?? 0),
      bottom: label.y - 17 + (element?.offsetHeight ?? 22) };
  }

  function markBounds(mark: Mark): Bounds {
    if ("points" in mark) return getStrokeBounds(mark, strokeBounds);
    if ("from" in mark) return boxBetween(mark.from, mark.to);
    return labelBounds(mark);
  }

  function hitTarget(at: Point): Target | undefined {
    const [x, y] = at;
    const radius = 6 / view.current.zoom;
    const label = topmost(drawing.labels, (item) => includesPoint(labelBounds(item), at));
    if (label) return { kind: "marks", mark: label };
    const card = hit(at);
    if (card) return { kind: "cards", id: card.id };
    const arrow = topmost(drawing.arrows, (item) => nearPath(arrowPoints(item.from, item.to), x, y, radius));
    if (arrow) return { kind: "marks", mark: arrow };
    const stroke = topmost(drawing.strokes, (item) => nearStroke(item, x, y, radius, strokeBounds)
      || insideClosedStroke(item, x, y, strokeBounds));
    if (stroke) return { kind: "marks", mark: stroke };
    const edge = topmost(board.edges, (item) => {
      const from = nodeIndex.get(item.from);
      const to = nodeIndex.get(item.to);
      return !!from && !!to && nearPath(edgePoints(from, to), x, y, radius);
    });
    if (edge) return { kind: "edges", id: edge.id };
  }

  function markChanges(map: (mark: Mark) => Mark): MarkChange[] {
    const picked = selectionRef.current.marks;
    if (picked.size === 0) return [];
    const changes: MarkChange[] = [];
    for (const kind of drawingKinds) {
      drawing[kind].forEach((before, index) => {
        if (picked.has(before)) changes.push({ kind, index, before, after: map(before) });
      });
    }
    return changes;
  }

  function showLabel(label: Label, next: Label) {
    const element = labels.current.get(label);
    if (!element) return;
    element.style.left = `${next.x}px`;
    element.style.top = `${next.y}px`;
  }

  function showMark(mark: Mark, next: Mark) {
    if ("points" in mark && "points" in next) movedStrokes.current.set(mark, next);
    else if ("from" in mark && "from" in next) movedArrows.current.set(mark, next);
    else if ("text" in mark && "text" in next) showLabel(mark, next);
  }

  function pickedCards() {
    return [...selectionRef.current.cards].flatMap((id) => nodeIndex.get(id) ?? []);
  }

  function movePicked(before: Card[], offset: Point) {
    if (!offset[0] && !offset[1]) return false;
    return commit(before.map((card) => setNode({ ...card, x: card.x + offset[0], y: card.y + offset[1] })),
      markChanges((mark) => translateMark(mark, offset)));
  }

  function settlePreview(cards: readonly Card[], marks: ReadonlySet<Mark>, committed: boolean) {
    const settle = () => {
      if (cards.length) {
        const touched = new Set(cards.map(({ id }) => id));
        for (const card of board.nodes) {
          if (!touched.has(card.id)) continue;
          nodeIndex.set(card.id, card);
          showCard(card);
        }
      }
      for (const mark of marks) if ("text" in mark) showLabel(mark, mark);
      movedStrokes.current.clear();
      movedArrows.current.clear();
      repaint();
    };
    // Keep the pointer preview visible until the durable operation settles.
    // Only the receipt updates the semantic records and drawing checkpoint.
    if (committed && semantic.current) void semantic.current.then(settle);
    else settle();
  }

  function selectArea(region: Bounds, extend: boolean) {
    const current = selectionRef.current;
    const next = extend ? { cards: new Set(current.cards), marks: new Set(current.marks), edges: new Set(current.edges) }
      : emptySelection();
    for (const card of board.nodes) if (within(cardBounds(card), region)) next.cards.add(card.id);
    for (const kind of drawingKinds) {
      for (const mark of drawing[kind]) if (within(markBounds(mark), region)) next.marks.add(mark);
    }
    chooseSelection(next);
  }

  function beginSelection(at: Point, extend: boolean): Gesture | undefined {
    const current = selectionRef.current;
    if (!extend && selectionSize(current) === 1) {
      const margin = 9 / view.current.zoom;
      const close = ([x, y]: Point) => Math.abs(at[0] - x) <= margin && Math.abs(at[1] - y) <= margin;
      const node = pickedCards()[0];
      if (node && close([node.x + node.width, node.y + node.height])) {
        return { kind: "resize", start: at, card: node, preview: node };
      }
      const mark = current.marks.values().next().value;
      if (mark && !("text" in mark)) {
        const box = markBounds(mark);
        if ("points" in mark && close([box.right, box.bottom])) {
          return { kind: "resize-mark", mark, box, start: at, preview: mark };
        }
        if ("from" in mark && (close(mark.to) || close(mark.from))) {
          return { kind: "resize-mark", mark, box, start: at, preview: mark, end: close(mark.to) ? "to" : "from" };
        }
      }
    }
    const target = hitTarget(at);
    if (!target) {
      if (!extend) chooseSelection(emptySelection());
      return { kind: "box", start: at, end: at, extend };
    }
    if (extend || !selectedTarget(current, target)) chooseSelection(toggleTarget(current, target, extend));
    const picked = selectionRef.current;
    if (!selectedTarget(picked, target) || target.kind === "edges") return;
    const cards = pickedCards();
    return { kind: "move", start: at, cards, bounds: movableBounds(cards, picked.marks, strokeBounds), offset: noOffset };
  }

  function resizeMark(active: Extract<Gesture, { kind: "resize-mark" }>, [x, y]: Point) {
    const { mark, box, start, end } = active;
    if ("from" in mark && end) {
      const old = mark[end];
      const next: Point = [geometry(old[0] + x - start[0]), geometry(old[1] + y - start[1])];
      const other = mark[end === "from" ? "to" : "from"];
      if (next[0] !== other[0] || next[1] !== other[1]) active.preview = { ...mark, [end]: next };
    } else if ("points" in mark) {
      const width = box.right - box.left;
      const height = box.bottom - box.top;
      const right = Math.max(box.left + 1, geometry(box.right + x - start[0]));
      const bottom = Math.max(box.top + 1, geometry(box.bottom + y - start[1]));
      const scaleX = width ? (right - box.left) / width : 1;
      const scaleY = height ? (bottom - box.top) / height : 1;
      active.preview = { ...mark, x: box.left, y: box.top,
        points: mark.points.map(([px, py]) => [geometry(box.left + (mark.x + px - box.left) * scaleX) - box.left,
          geometry(box.top + (mark.y + py - box.top) * scaleY) - box.top]) };
    }
    showMark(mark, active.preview);
  }

  function connect(card?: Card) {
    if (!card || locked.current) return;
    const source = dependency.current;
    if (source && source !== card.id) {
      const accepted = commit([{ type: "setEdge", edge: { id: id(), from: source, to: card.id, kind: "dependency", revision: 0 } }]);
      if (accepted) dependency.current = undefined;
    } else {
      dependency.current = card.id;
      setNotice("Select the card that depends on this one.");
    }
  }

  function start(event: PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || locked.current || gesture.current || edit || remoteBusy.current) return;
    event.currentTarget.focus({ preventScroll: true });
    if (tool !== "pan" && !space.current && !canEdit()) return;
    const start = point(event);
    if (tool === "pan" || space.current) {
      gesture.current = { kind: "pan", start: point(event, false), view: { ...view.current } };
    } else if (tool === "pen") {
      if (drawing.strokes.length >= 2_000 || points.current > 179_998) return setNotice("This board reached its stroke limit.");
      gesture.current = { kind: "pen", stroke: { id: id(), x: start[0], y: start[1], points: [[0, 0]], width: 3, color: "slate" } };
    } else if (tool === "rectangle" || tool === "diamond" || tool === "ellipse" || tool === "line") {
      if (drawing.strokes.length >= 2_000 || points.current + outline(tool, [0, 0]).length > 180_000) {
        return setNotice("This board reached its stroke limit.");
      }
      gesture.current = { kind: "shape", shape: tool, stroke: { id: id(), x: start[0], y: start[1], points: [], width: 2, color: "slate" } };
    } else if (tool === "eraser") {
      const removed = new Set<Mark>();
      eraseAt(event, removed);
      gesture.current = { kind: "eraser", removed };
    } else if (tool === "arrow") {
      if (drawing.arrows.length >= 1_000) return setNotice("This board reached its arrow limit.");
      gesture.current = { kind: "arrow", arrow: { from: start, to: start, color: "slate" } };
    } else if (tool === "text") {
      gesture.current = { kind: "text", at: start };
    } else if (tool === "connect" && canEdit()) {
      const card = hit(start);
      selectCard(card);
      connect(card);
      return;
    } else if (tool === "select" && canEdit()) {
      gesture.current = beginSelection(start, event.shiftKey);
    }
    if (gesture.current) event.currentTarget.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent<HTMLCanvasElement>) {
    const active = gesture.current;
    if (!active || active.kind === "text") return;
    if (active.kind === "pan") {
      const [x, y] = point(event, false);
      view.current.x = active.view.x + x - active.start[0];
      view.current.y = active.view.y + y - active.start[1];
    } else if (active.kind === "move") {
      const [x, y] = point(event);
      active.offset = boundedOffset([x - active.start[0], y - active.start[1]], active.bounds);
      const [dx, dy] = active.offset;
      for (const card of active.cards) {
        const next = { ...card, x: card.x + dx, y: card.y + dy };
        nodeIndex.set(card.id, next);
        showCard(next);
      }
      for (const mark of selectionRef.current.marks) showMark(mark, translateMark(mark, active.offset));
    } else if (active.kind === "resize") {
      const [x, y] = point(event);
      const { card } = active;
      active.preview = { ...card,
        width: Math.min(4096, Math.max(48, geometry(card.width + x - active.start[0]))),
        height: Math.min(4096, Math.max(32, geometry(card.height + y - active.start[1]))) };
      nodeIndex.set(card.id, active.preview);
      showCard(active.preview);
    } else if (active.kind === "resize-mark") resizeMark(active, point(event));
    else if (active.kind === "box") active.end = point(event);
    else if (active.kind === "arrow") active.arrow.to = point(event);
    else if (active.kind === "eraser") eraseAt(event, active.removed);
    else if (active.kind === "shape") {
      const [x, y] = point(event);
      active.stroke.points = outline(active.shape, [x - active.stroke.x, y - active.stroke.y]);
    } else if (active.stroke.points.length < Math.min(1024, 180_000 - points.current)) {
      const [x, y] = point(event);
      active.stroke.points.push([x - active.stroke.x, y - active.stroke.y]);
    }
    repaint();
  }

  function finish(canceled: boolean) {
    const active = gesture.current;
    gesture.current = undefined;
    if (!active) return;
    if (active.kind === "move") {
      const marks = selectionRef.current.marks;
      settlePreview(active.cards, marks, !canceled && movePicked(active.cards, active.offset));
    } else if (active.kind === "resize") {
      const changed = active.card.width !== active.preview.width || active.card.height !== active.preview.height;
      settlePreview([active.card], selectionRef.current.marks, !canceled && changed && commit([setNode(active.preview)]));
    } else if (active.kind === "resize-mark") {
      movedStrokes.current.clear();
      movedArrows.current.clear();
      if (!canceled && active.preview !== active.mark) commit([], markChanges(() => active.preview));
    } else if (!canceled && active.kind === "text") {
      const target = hitTarget(active.at);
      const card = target?.kind === "cards" ? nodeIndex.get(target.id) : undefined;
      if (card) editCard(card);
      else if (target?.kind === "marks" && "text" in target.mark) editLabel(target.mark);
      else openEdit({ kind: "text", point: active.at });
    } else if (!canceled && active.kind === "box") {
      if (active.end !== active.start) selectArea(boxBetween(active.start, active.end), active.extend);
    } else if (!canceled && (active.kind === "pen" || active.kind === "shape") && active.stroke.points.length >= 2) {
      addMark("strokes", active.stroke);
      if (active.kind === "shape" && !keepTool) {
        setTool("select");
        chooseSelection(toggleTarget(selectionRef.current, { kind: "marks", mark: active.stroke }, false));
      }
    } else if (!canceled && active.kind === "arrow" &&
      (active.arrow.from[0] !== active.arrow.to[0] || active.arrow.from[1] !== active.arrow.to[1])) {
      addMark("arrows", active.arrow);
      if (!keepTool) {
        setTool("select");
        chooseSelection(toggleTarget(selectionRef.current, { kind: "marks", mark: active.arrow }, false));
      }
    } else if (!canceled && active.kind === "eraser" && active.removed.size) {
      commit([], removeSelection(board, { ...emptySelection(), marks: active.removed }).marks);
    }
    repaint();
    if (remoteNeeded.current) scheduleRemote();
  }

  function addCard() {
    if (edit || locked.current || gesture.current || semantic.current || failed.current || remoteBusy.current) return;
    const camera = view.current;
    const shift = 32 * (board.nodes.length % 7);
    const at: Point = [geometry((70 + shift - camera.x) / camera.zoom), geometry((90 + shift - camera.y) / camera.zoom)];
    openEdit({ kind: "card", card: makeCard("", at, (board.nodes.at(-1)?.order ?? -1) + 1), fresh: true });
  }

  function openEdit(next: Edit) {
    const active = document.activeElement;
    editAnchor.current = active instanceof HTMLElement ? active : undefined;
    setEdit(next);
  }

  function enterEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!edit || locked.current) return;
    const values = new FormData(event.currentTarget);
    const text = String(values.get("title")).trim();
    if (!text) return;
    if (new TextEncoder().encode(text).length > 1024) return setNotice("Enter a title of 1–1024 bytes.");
    if (edit.kind === "text") {
      if (!edit.label && drawing.labels.length >= 1_000) return setNotice("This board reached its text limit.");
      const label = { x: edit.point[0], y: edit.point[1], text };
      const index = edit.label ? drawing.labels.indexOf(edit.label) : drawing.labels.length;
      if (index < 0 || !commit([], [{ kind: "labels", index, before: edit.label, after: label }])) return;
      chooseSelection(toggleTarget(selectionRef.current, { kind: "marks", mark: label }, false));
      if (!keepTool) setTool("select");
    } else {
      if (semantic.current || failed.current) return;
      const card: Card = {
        ...edit.card, title: text, description: String(values.get("description")),
        kind: values.get("kind") as Card["kind"], status: values.get("status") as Card["status"],
        priority: values.get("priority") as Card["priority"], width: Number(values.get("width")),
        height: Number(values.get("height")), x: Number(values.get("x")), y: Number(values.get("y")),
        parent: (values.get("parent") || null) as Card["parent"],
      };
      if (card.parent !== edit.card.parent) card.order = (board.nodes.at(-1)?.order ?? -1) + 1;
      if (!commit([setNode(card)], [], "record", toggleTarget(selectionRef.current, { kind: "cards", id: card.id }, false))) return;
    }
    closeEdit(canvas.current);
  }

  async function flush() {
    await semantic.current;
    if (failed.current) throw new Error("Resolve the unsaved card change before closing or exporting.");
    await saver.flush();
  }

  function leave(windowClose: boolean, discard = false) {
    if (locked.current) return;
    finish(true);
    locked.current = true;
    setPending(true);
    setCloseFailure(undefined);
    saver.stopTimer();
    void (async () => {
      try {
        if (!discard) {
          if (draftChanged.current) throw new Error("Save or cancel the open edit before closing.");
          await deadline(flush(), 4_000);
        }
        saver.stopTimer();
        await invoke("close_board", { scope });
        if (windowClose) await invoke("finish_close");
        else onClose();
      } catch (error) {
        setCloseFailure({ windowClose, message: String(error) });
      } finally {
        locked.current = false;
        setPending(false);
      }
    })();
  }
  latestClose.current = leave;

  async function prepareExport(format: "png" | "svg" | "board") {
    if (locked.current || gesture.current) return;
    locked.current = true;
    setPending(true);
    try {
      await deadline(flush(), 4_000);
      const written = format === "board"
        ? await invoke<boolean>("export_board", { scope })
        : await invoke<boolean>("export_preview", await (await exportImage(board, format)).arrayBuffer(),
          { headers: { "x-board-image": format } });
      if (written) setNotice("Export saved.");
    } catch (error) {
      setNotice(String(error));
    } finally {
      locked.current = false;
      setPending(false);
    }
  }

  function zoom(factor: number) {
    if (gesture.current) return;
    view.current.zoom = Math.min(2, Math.max(0.3, view.current.zoom * factor));
    setZoomPercent(Math.round(view.current.zoom * 100));
    repaint();
  }

  function resetView() {
    if (gesture.current) return;
    view.current = { x: 0, y: 0, zoom: 1 };
    setZoomPercent(100);
    repaint();
  }

  function reorder(card: Card, direction: number) {
    const siblings = board.nodes.filter((node) => node.parent === card.parent);
    const other = siblings[siblings.indexOf(card) + direction];
    if (other) commit([setNode({ ...card, order: other.order }), setNode({ ...other, order: card.order })]);
  }

  function editCard(card: Card) {
    if (!edit && !locked.current && !semantic.current && !failed.current && !remoteBusy.current) {
      selectCard(card);
      openEdit({ kind: "card", card, fresh: false });
    }
  }

  function editLabel(label: Label) {
    if (!edit && canEdit()) {
      chooseSelection(toggleTarget(selectionRef.current, { kind: "marks", mark: label }, false));
      openEdit({ kind: "text", point: [label.x, label.y], label });
    }
  }

  function editSelected() {
    const picked = selectionRef.current;
    if (selectionSize(picked) !== 1) return;
    const card = pickedCards()[0];
    const mark = picked.marks.values().next().value;
    if (card) editCard(card);
    else if (mark && "text" in mark) editLabel(mark);
  }

  function deleteSelected() {
    if (gesture.current || edit) return;
    const { changes, marks } = removeSelection(board, selectionRef.current);
    commit(changes, marks);
  }

  function duplicateSelected() {
    if (gesture.current || edit || !canEdit()) return;
    const picked = selectionRef.current;
    const offset = boundedOffset([24, 24], movableBounds(pickedCards(), picked.marks, strokeBounds));
    const { changes, marks, selected } = duplicateSelection(board, picked, offset);
    const limits = { strokes: 2_000, labels: 1_000, arrows: 1_000 };
    const count = { strokes: 0, labels: 0, arrows: 0 };
    let addedPoints = 0;
    for (const { kind, after } of marks) {
      count[kind]++;
      if (after && "points" in after) addedPoints += after.points.length;
    }
    if (drawingKinds.some((kind) => drawing[kind].length + count[kind] > limits[kind])
      || points.current + addedPoints > 180_000 || board.nodes.length + selected.cards.size > 2_000) {
      setNotice("This board reached its object limit.");
      return;
    }
    commit(changes, marks, "record", selected);
  }

  function cycleCards(direction: number) {
    if (!board.nodes.length) return;
    const index = board.nodes.findIndex((item) => item.id === focusedCard.current);
    const next = index === -1 ? (direction > 0 ? 0 : board.nodes.length - 1)
      : (index + direction + board.nodes.length) % board.nodes.length;
    selectCard(board.nodes[next], true);
  }

  function selectCard(card?: Card, reveal = false) {
    chooseSelection(card ? toggleTarget(selectionRef.current, { kind: "cards", id: card.id }, false) : emptySelection());
    if (!card || !reveal || !canvas.current) return;
    const camera = view.current;
    const left = card.x * camera.zoom + camera.x;
    const top = card.y * camera.zoom + camera.y;
    const width = canvas.current.clientWidth;
    const height = canvas.current.clientHeight;
    const tools = panel.current?.querySelector(".lean-toolbar")?.getBoundingClientRect();
    const shelf = panel.current?.querySelector(".lean-shelf, .agent-panel")?.getBoundingClientRect();
    const bounds = canvas.current.getBoundingClientRect();
    const leftLimit = 12;
    const rightLimit = shelf ? shelf.left - bounds.left - 12 : width - 12;
    const topLimit = tools ? tools.bottom - bounds.top + 12 : 62;
    const bottomLimit = height - 62;
    if (left < leftLimit || top < topLimit || left + card.width * camera.zoom > rightLimit
      || top + card.height * camera.zoom > bottomLimit) {
      camera.x += (leftLimit + Math.max(leftLimit, rightLimit)) / 2 - left - card.width * camera.zoom / 2;
      camera.y += (topLimit + bottomLimit) / 2 - top - card.height * camera.zoom / 2;
      repaint();
    }
  }

  function cancelEdit() {
    closeEdit(editAnchor.current);
  }

  function closeEdit(anchor?: HTMLElement | null) {
    editAnchor.current = undefined;
    draftChanged.current = false;
    setEdit(undefined);
    requestAnimationFrame(() => {
      const target = anchor?.isConnected && !anchor.matches(":disabled") ? anchor : canvas.current;
      target?.focus({ preventScroll: true });
    });
  }

  function closePanel(id: "cards" | "agents") {
    if (id === "cards") setInspector(false);
    else setAgents(false);
    (id === "cards" ? listToggle : agentsToggle).current?.focus();
  }

  function selectTool(next: Tool) {
    if (gesture.current) finish(true);
    setTool(next);
    canvas.current?.focus({ preventScroll: true });
    dependency.current = undefined;
    setNotice("");
  }

  function closeDisclosure(disclosure: HTMLDetailsElement | null) {
    if (!disclosure?.open) return false;
    disclosure.open = false;
    disclosure.querySelector("summary")?.focus();
    return true;
  }

  function onBoardKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.defaultPrevented || edit || closeFailure || keyboardHelp) return;
    const surface = event.target === canvas.current;
    if (event.key === "Escape") {
      if (gesture.current) finish(true);
      else if (closeDisclosure(menu.current) || closeDisclosure(moreTools.current)) {
        event.preventDefault();
        return;
      } else if (agents) closePanel("agents");
      else if (inspector) closePanel("cards");
      else {
        dependency.current = undefined;
        chooseSelection(emptySelection());
        setNotice("");
        canvas.current?.focus({ preventScroll: true });
      }
      event.preventDefault();
      return;
    }
    const target = event.target as HTMLElement;
    if (locked.current || target.closest("input, textarea, select, [contenteditable], .agent-panel")) return;
    const shortcut = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      if (shortcut === "z" || shortcut === "y") {
        event.preventDefault();
        changeHistory(shortcut === "y" || event.shiftKey);
      } else if (shortcut === "d" && !event.shiftKey) {
        event.preventDefault();
        duplicateSelected();
      } else if (shortcut === "a" && !event.shiftKey && !gesture.current) {
        event.preventDefault();
        chooseSelection({ cards: new Set(board.nodes.map((card) => card.id)),
          marks: new Set([...drawing.strokes, ...drawing.arrows, ...drawing.labels]), edges: new Set(board.edges.map((edge) => edge.id)) });
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || gesture.current) return;
    const next = tools.find((item) => item.key === shortcut || item.number === shortcut);
    if (next && next.id !== "image") {
      event.preventDefault();
      selectTool(next.id);
      return;
    }
    if (shortcut === "c") {
      event.preventDefault();
      selectTool("connect");
      return;
    }
    if (shortcut === "q" || shortcut === "?" || shortcut === "f1") {
      event.preventDefault();
      if (shortcut === "q") setKeepTool(!keepTool);
      else setKeyboardHelp(true);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      deleteSelected();
    } else if (event.key === "Insert" || shortcut === "n") {
      event.preventDefault();
      addCard();
    } else if (event.key === "+" || event.key === "=" || event.key === "-") {
      event.preventDefault();
      zoom(event.key === "-" ? 1 / 1.1 : 1.1);
    } else if (surface) {
      const direction = ({ ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowDown: [0, 1] } as Record<string, Point>)[event.key];
      if (direction) {
        event.preventDefault();
        const [dx, dy] = direction;
        if (tool === "pan") {
          view.current.x -= 64 * dx;
          view.current.y -= 64 * dy;
          repaint();
        } else if (tool === "connect" || !selectionSize(selectionRef.current)) {
          cycleCards(dx + dy);
        } else if (tool === "select" && canEdit()) {
          const cards = pickedCards();
          const size = event.shiftKey ? 10 : 1;
          const bounds = movableBounds(cards, selectionRef.current.marks, strokeBounds);
          movePicked(cards, boundedOffset([dx * size, dy * size], bounds));
        }
      } else if (event.key === "[" || event.key === "]") {
        event.preventDefault();
        cycleCards(event.key === "[" ? -1 : 1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (tool === "connect") connect(pickedCards()[0]);
        else editSelected();
      } else if (event.key === " ") {
        event.preventDefault();
        space.current = true;
      }
    }
  }

  const count = selectionSize(selection);
  const card = count === 1 ? nodeIndex.get(selection.cards.values().next().value ?? "") : undefined;
  const mark = count === 1 ? selection.marks.values().next().value : undefined;
  const edge = count === 1 && selection.edges.size ? board.edges.find((edge) => selection.edges.has(edge.id)) : undefined;
  const group = card && nodeIndex.get(card.parent ?? "");
  const unavailable = pending || !canEdit();
  return (
    <div className="board-editor lean-editor" ref={panel} data-fixture={window.__BOARD_FIXTURE__}
      data-initial-elements={opened.nodes.length * 2 + opened.edges.length + drawing.strokes.length}
      data-semantic-revision={revision.current} data-renderer="lean"
      onPointerDownCapture={(event) => {
        const target = event.target as Node;
        for (const disclosure of [menu.current, moreTools.current]) {
          if (disclosure?.open && !disclosure.contains(target)) disclosure.open = false;
        }
      }}
      onKeyDown={onBoardKey} onKeyUp={(event) => {
        if (event.key === " ") space.current = false;
      }}>
      <h1 className="visually-hidden" dir="auto">{info.title}</h1>
      <details ref={menu} className="board-header">
        <summary className="board-control" aria-label="Board menu" title="Board menu"><Icon name="menu" size={16} /></summary>
        <div className="board-menu">
          <button type="button" disabled={pending} onClick={() => { closeDisclosure(menu.current); addCard(); }}><Icon name="add" size={16} />Add card</button>
          <button type="button" data-menu-history="undo" disabled={unavailable || !undoHistory.current.length}
            onClick={() => { closeDisclosure(menu.current); changeHistory(); }}><Icon name="undo" size={16} />Undo</button>
          <button type="button" disabled={unavailable || !redoHistory.current.length}
            onClick={() => { closeDisclosure(menu.current); changeHistory(true); }}><Icon name="redo" size={16} />Redo</button>
          <button type="button" disabled={unavailable || !count}
            onClick={() => { closeDisclosure(menu.current); deleteSelected(); }}>Delete selection</button>
          <details className="export-menu"><summary><Icon name="export" size={16} />Export</summary>
            <div>
              <button type="button" disabled={pending} onClick={() => void prepareExport("board")}>Board file…</button>
              <button type="button" disabled={pending} onClick={() => void prepareExport("png")}>PNG…</button>
              <button type="button" disabled={pending} onClick={() => void prepareExport("svg")}>SVG…</button>
            </div>
          </details>
          <button type="button" disabled={pending} onClick={() => leave(false)}><Icon name="back" size={16} />Close board</button>
        </div>
      </details>
      <p id="board-keyboard-summary" className="visually-hidden">Press N to add a card. Arrow keys move the selection. Enter edits selected text. F1 opens all shortcuts.</p>
      <div role="status" aria-atomic="true" className="visually-hidden">{card ? `Selected ${card.title}` : count ? `${count} selected` : ""}</div>
      <canvas ref={canvas} className={`interactive lean-canvas tool-${tool}`} data-board-surface tabIndex={0}
        aria-label="Drawing canvas" aria-describedby="board-keyboard-summary"
        onPointerDown={start} onPointerMove={move} onPointerUp={() => finish(false)} onPointerCancel={() => finish(true)}
        onLostPointerCapture={() => finish(true)}
        onDoubleClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const camera = view.current;
          if (tool !== "select") return;
          const target = hitTarget([(event.clientX - rect.left - camera.x) / camera.zoom, (event.clientY - rect.top - camera.y) / camera.zoom]);
          if (target?.kind === "cards") {
            const card = nodeIndex.get(target.id);
            if (card) editCard(card);
          } else if (target?.kind === "marks" && "text" in target.mark) editLabel(target.mark);
        }} />
      <div className="lean-cards" aria-hidden="true" ref={cardsLayer}>
        {board.nodes.map((item) => (
          <div key={item.id} dir="auto" className="lean-card" data-card-id={item.id}
            data-kind={item.kind} data-status={item.status} data-priority={item.priority} data-dropped={item.dropped}
            data-badge={item.dropped ? "Dropped" : statuses[item.status]}
            data-selected={selection.cards.has(item.id)} data-resizable={count === 1}
            ref={(element) => { if (element) cards.current.set(item.id, element); else cards.current.delete(item.id); }}
            style={{ left: item.x, top: item.y, width: item.width, height: item.height }}
            onClick={() => tool === "connect" ? connect(item) : editCard(item)}>
            <span className="card-title">{item.title}</span>
          </div>
        ))}
        {drawing.labels.map((label, index) => <span className="lean-label" dir="auto" key={index}
          data-selected={selection.marks.has(label)}
          ref={(element) => { if (element) labels.current.set(label, element); else labels.current.delete(label); }}
          style={{ left: label.x, top: label.y }}>{label.text}</span>)}
      </div>
      {!board.nodes.length && !drawing.strokes.length && !drawing.labels.length && !drawing.arrows.length && <div className="lean-empty">
        <strong>{brand.displayName}</strong>
        <p>Draw here. Your plan starts on the board.</p>
        <small>Press N to add a card, or pick a tool to sketch and write.</small>
      </div>}
      <div className="lean-toolbar" role="toolbar" aria-label="Board tools">
        <button type="button" aria-pressed={keepTool} onClick={() => setKeepTool(!keepTool)}
          aria-label="Keep selected tool active" title="Keep selected tool active after drawing (Q)">
          <Icon name={keepTool ? "lock" : "unlock"} size={16} />
        </button>
        <span className="tool-divider" aria-hidden="true" />
        {tools.map(({ id, label, key, number }) => <button key={id} type="button" data-tool={id}
          disabled={pending || id === "image"} aria-pressed={tool === id} aria-label={label}
          title={key ? `${label} (${key.toUpperCase()}${number ? ` or ${number}` : ""})` : label}
          onClick={() => { if (id !== "image") selectTool(id); }}>
          <Icon name={id} size={16} />{number && <span className="tool-key" aria-hidden="true">{number}</span>}
        </button>)}
        <span className="tool-divider" aria-hidden="true" />
        <details ref={moreTools} className="more-tools">
          <summary aria-label="More tools" title="More tools"><Icon name="more" size={16} /></summary>
          <div className="board-menu">
            <button type="button" data-tool="connect" disabled={pending} aria-pressed={tool === "connect"} title="Dependency (C)"
              onClick={() => { closeDisclosure(moreTools.current); selectTool("connect"); }}>
              <Icon name="connect" size={16} />Dependency
            </button>
          </div>
        </details>
      </div>
      <div className="lean-view">
        <div className="lean-zoom board-control" role="group" aria-label="Canvas view">
          <button type="button" onClick={() => zoom(1 / 1.1)} aria-label="Zoom out" title="Zoom out"><Icon name="minus" size={16} /></button>
          <button type="button" onClick={resetView} title="Reset view" aria-label={`Reset view, zoom ${zoomPercent}%`}>{zoomPercent}%</button>
          <button className="zoom-in-button" type="button" onClick={() => zoom(1.1)} aria-label="Zoom in" title="Zoom in"><Icon name="add" size={16} /></button>
        </div>
        <div className="lean-history board-control" role="group" aria-label="Board history">
          <button type="button" data-history="undo" disabled={unavailable || !undoHistory.current.length} onClick={() => changeHistory()} title="Undo (Ctrl/Cmd+Z)">
            <Icon name="undo" size={16} /><span className="visually-hidden">Undo</span>
          </button>
          <button type="button" data-history="redo" disabled={unavailable || !redoHistory.current.length} onClick={() => changeHistory(true)} title="Redo (Ctrl/Cmd+Shift+Z)">
            <Icon name="redo" size={16} /><span className="visually-hidden">Redo</span>
          </button>
        </div>
      </div>
      <button className="lean-help board-control" type="button" onClick={() => setKeyboardHelp(true)} title="Shortcuts">
        <Icon name="help" size={16} /><span className="visually-hidden">Shortcuts</span>
      </button>
      <div className="lean-board-actions" role="group" aria-label="Board panels and export">
        <button ref={listToggle} className="board-control" type="button" aria-expanded={inspector} aria-controls={inspector ? "board-card-list" : undefined}
          onClick={() => {
            if (inspector) closePanel("cards");
            else {
              setAgents(false);
              setInspector(true);
              requestAnimationFrame(() => {
                (list.current?.querySelector<HTMLElement>("[tabindex='0']")
                  ?? panel.current?.querySelector<HTMLButtonElement>(".lean-inspector header button"))?.focus();
              });
            }
          }}><Icon name="library" size={16} />Library</button>
      </div>
        <button ref={agentsToggle} className="lean-presence" type="button" title={saveState.message}
          aria-expanded={agents} aria-controls={agents ? "board-agents" : undefined}
          onClick={() => {
            if (agents) closePanel("agents");
            else {
              setInspector(false);
              setAgents(true);
              requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>(".agent-panel header button")?.focus());
            }
          }}><span aria-hidden="true" />Agents</button>
      {agents && <AgentPanel scope={scope} onClose={() => closePanel("agents")} />}
      {!agents && (inspector || count > 0) && <div className="lean-shelf">
      {inspector && <aside id="board-card-list" className="lean-inspector" aria-label="Card list">
        <header><h2>Cards</h2><button type="button" title="Close cards" aria-label="Close cards" onClick={() => closePanel("cards")}><Icon name="close" size={16} /></button></header>
        {board.nodes.length === 0 && <p>No cards yet.</p>}
        <ol ref={list} onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
          const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
          const start = buttons.indexOf(event.target as HTMLButtonElement);
          if (start < 0) return;
          event.preventDefault();
          const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : (start + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
          const item = board.nodes[index];
          if (item) selectCard(item, true);
          buttons[index]?.focus();
        }}>{board.nodes.map((item, index) => (
          <li key={item.id}><button dir="auto" type="button" data-status={item.status} aria-pressed={selection.cards.has(item.id)}
            tabIndex={(card ? card.id === item.id : index === 0) ? 0 : -1}
            onClick={() => { selectCard(item, true); if (tool === "connect") connect(item); }}>{item.title}</button></li>
        ))}</ol>
      </aside>}
      {count > 0 && <aside className="lean-selection" aria-label="Selection">
        {card && <>
        <strong dir="auto">{card.title}</strong>
        <small>{kinds[card.kind]} · {statuses[card.status]} · {priorities[card.priority]}{group && ` · ${group.title}`}</small>
        {card.kind === "task" && <small>Status source {card.statusSource ? "paired client" : "local editor"}</small>}
        <div>
          <button type="button" disabled={unavailable} onClick={() => editCard(card)}>Edit card</button>
          <button type="button" disabled={unavailable} onClick={() => commit([setNode({ ...card, dropped: !card.dropped })])}>{card.dropped ? "Restore" : "Drop"}</button>
          <button type="button" disabled={unavailable} onClick={() => reorder(card, -1)}>Move earlier</button>
          <button type="button" disabled={unavailable} onClick={() => reorder(card, 1)}>Move later</button>
        </div>
        {board.edges.filter((edge) => edge.from === card.id || edge.to === card.id).map((edge) => (
          <div key={edge.id}>
            <span dir="auto">{edge.from === card.id ? "Required by " : "Requires "}{board.nodes.find((item) => item.id === (edge.from === card.id ? edge.to : edge.from))?.title}</span>
            <button type="button" disabled={unavailable} onClick={() => commit([{ type: "removeEdge", id: edge.id }])}>Remove link</button>
          </div>
        ))}
        </>}
        {edge && <strong dir="auto">{nodeIndex.get(edge.from)?.title} → {nodeIndex.get(edge.to)?.title}</strong>}
        {mark && <>
          <strong>{"text" in mark ? "Board text" : "points" in mark ? "Stroke" : "Arrow"}</strong>
          {"text" in mark ? <button type="button" disabled={unavailable} onClick={() => editLabel(mark)}>Edit text</button>
            : <label>Color<select disabled={unavailable} value={mark.color === "green" ? "slate" : mark.color}
                onChange={(event) => {
                  const color = event.target.value as Ink;
                  commit([], markChanges((mark) => ({ ...mark, color })));
                }}>{choices(inkChoices)}</select></label>}
          {"points" in mark && <label>Stroke width<select disabled={unavailable} value={mark.width}
            onChange={(event) => {
              const width = Number(event.target.value);
              commit([], markChanges((mark) => ({ ...mark, width })));
            }}>
            {[...new Set([1, 2, 3, 4, 6, 8, 12, mark.width])].sort((a, b) => a - b)
              .map((width) => <option value={width} key={width}>{width}</option>)}
          </select></label>}
        </>}
        {count > 1 && <strong>{count} objects selected</strong>}
        <div>
          <button type="button" disabled={unavailable || (!selection.cards.size && !selection.marks.size)}
            onClick={duplicateSelected}>Duplicate</button>
          <button type="button" disabled={unavailable} onClick={deleteSelected}>Delete</button>
        </div>
      </aside>}
      </div>}
      {keyboardHelp && <Modal title="Board shortcuts" cancel={() => setKeyboardHelp(false)}>
        <h2>Board shortcuts</h2>
        <dl className="board-shortcuts">
          <dt>V / 1</dt><dd>Selection. Drag an empty area to select objects, or Shift-click to add and remove objects.</dd>
          <dt>Arrow keys</dt><dd>Move the selection. Hold Shift for larger steps. In Hand mode, arrows pan.</dd>
          <dt>[ / ]</dt><dd>Select the previous or next card.</dd>
          <dt>Enter / double-click</dt><dd>Edit a card or existing board text. In Dependency mode, Enter links cards.</dd>
          <dt>N / Insert</dt><dd>Add a card.</dd>
          <dt>C</dt><dd>Dependency tool.</dd>
          <dt>Ctrl / Cmd + A</dt><dd>Select all objects.</dd>
          <dt>Ctrl / Cmd + D</dt><dd>Duplicate the selection.</dd>
          <dt>Delete / Backspace</dt><dd>Delete the selection.</dd>
          <dt>Plus / minus</dt><dd>Zoom in or out.</dd>
          <dt>Ctrl / Cmd + Z</dt><dd>Undo the last board edit.</dd>
          <dt>Ctrl / Cmd + Shift + Z</dt><dd>Redo. Ctrl / Cmd + Y also works.</dd>
          <dt>Ctrl / Cmd + Enter</dt><dd>Save the open card or text edit.</dd>
          <dt>Escape</dt><dd>Cancel a gesture or close the active panel.</dd>
        </dl>
        <button type="button" data-initial-focus onClick={() => setKeyboardHelp(false)}>Close shortcuts</button>
      </Modal>}
      {edit && <Modal title={edit.kind === "text" ? edit.label ? "Edit text" : "Place text" : edit.fresh ? "Add card" : "Edit card"} cancel={cancelEdit}>
        <h2>{edit.kind === "text" ? edit.label ? "Edit text" : "Place text" : edit.fresh ? "Add card" : "Edit card"}</h2>
        <form className="lean-edit" onSubmit={enterEdit} onChange={() => { draftChanged.current = true; }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing || (!event.ctrlKey && !event.metaKey)) return;
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }}>
        <label>{edit.kind === "card" ? "Title" : "Board text"}
          <textarea name="title" dir="auto" data-initial-focus required
            className={edit.kind === "text" ? "lean-note-input" : undefined}
            defaultValue={edit.kind === "card" ? edit.card.title : edit.label?.text ?? ""} maxLength={512} />
        </label>
        {edit.kind === "card" && <>
          <label>Description<textarea name="description" dir="auto" defaultValue={edit.card.description} maxLength={4096} /></label>
          <div className="edit-fields">
            <label>Type<select name="kind" defaultValue={edit.card.kind}>{choices(kinds)}</select></label>
            <label>Status<select name="status" defaultValue={edit.card.status}>{choices(statuses)}</select></label>
            <label>Priority<select name="priority" defaultValue={edit.card.priority}>{choices(priorities)}</select></label>
            <label>X position<input name="x" type="number" min={-100000} max={100000} step="any" required defaultValue={edit.card.x} /></label>
            <label>Y position<input name="y" type="number" min={-100000} max={100000} step="any" required defaultValue={edit.card.y} /></label>
            <label>Width<input name="width" type="number" min={48} max={4096} step="any" required defaultValue={edit.card.width} /></label>
            <label>Height<input name="height" type="number" min={32} max={4096} step="any" required defaultValue={edit.card.height} /></label>
            <label>Group<select name="parent" defaultValue={edit.card.parent ?? ""}>
              <option value="">None</option>
              {board.nodes.filter((item) => item.kind === "group" && item.id !== edit.card.id).map((item) => (
                <option key={item.id} value={item.id}>{item.title}</option>
              ))}
            </select></label>
          </div>
        </>}
        <div className="dialog-actions">
          <button type="button" onClick={cancelEdit}>Cancel</button>
          <button type="submit" disabled={unavailable}>{edit.kind === "card" ? edit.fresh ? "Create card" : "Save card" : edit.label ? "Save text" : "Place text"}</button>
        </div>
        </form>
      </Modal>}
      <div className="lean-status" data-visible={!!(notice || failed.current || saveState.failed || saveState.pending)}>
        {notice ? <output data-card-save="">{notice}</output> : <span className="visually-hidden">Revision {revision.current}</span>}
        <output data-drawing-save="" className={saveState.failed || saveState.pending ? undefined : "visually-hidden"}>{saveState.message}</output>
        {failed.current && <div><button type="button" disabled={pending} onClick={() => { if (failed.current) send(failed.current); }}>Retry card change</button>
          <button type="button" disabled={pending} onClick={() => {
            failed.current = undefined;
            setNotice("");
            if (remoteNeeded.current) scheduleRemote();
          }}>Dismiss card change</button></div>}
        {saveState.failed && <button type="button" disabled={pending} onClick={() => void saver.flush().catch(() => {})}>Retry drawing save</button>}
      </div>
      {closeFailure && <Modal title="Could not close board" className="lean-close" cancel={() => setCloseFailure(undefined)} role="alertdialog">
        <p>{closeFailure.message}</p>
        <button type="button" onClick={() => leave(closeFailure.windowClose)}>Retry close</button>
        <button type="button" data-initial-focus onClick={() => setCloseFailure(undefined)}>Keep editing</button>
        <button type="button" onClick={() => leave(closeFailure.windowClose, true)}>Discard pending changes</button>
      </Modal>}
    </div>
  );
}
