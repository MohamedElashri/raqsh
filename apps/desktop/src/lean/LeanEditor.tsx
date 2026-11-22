import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MutableRefObject, type PointerEvent } from "react";
import { id, kinds, makeCard, priorities, statuses, type Arrow, type Card, type Change, type Drawing, type Id, type OpenBoard,
  type Operation, type Point, type Receipt, type Stroke } from "../model";
import { exportImage, paintPaths, type Board, type View, type VisibleBoard } from "./board";
import { Checkpoint, type SaveState } from "./checkpoint";
import { nearPath, nearStroke, outline, type Shape } from "./geometry";
import AgentPanel from "./AgentPanel";
import { brand } from "../generated/brand";
import { Icon } from "../Icon";
import { Modal } from "../Modal";
import "../editor.css";
import "./lean.css";

type Tool = "select" | "pan" | "pen" | "text" | "arrow" | "connect" | "eraser" | Shape;
type Rectangle = Pick<Card, "x" | "y" | "width" | "height">;
type Gesture =
  | { kind: "pan"; start: Point; view: View }
  | { kind: "card"; start: Point; card: Card; before: Rectangle; resize: boolean }
  | { kind: "pen"; stroke: Stroke }
  | { kind: "shape"; shape: Shape; stroke: Stroke }
  | { kind: "eraser"; removed: Set<Mark> }
  | { kind: "arrow"; arrow: Arrow };
type DrawingKind = keyof Drawing;
type Mark = Drawing[DrawingKind][number];
type DrawingChange = { kind: DrawingKind; mark: Mark; index: number };
type DrawingEdit = { remove: boolean; changes: DrawingChange[] };
type Edit = { kind: "card"; card: Card; fresh: boolean } | { kind: "text"; point: Point };
type Delta = Pick<Receipt, "revision" | "changes">;
type DeltaPage = { revision: number; deltas: Delta[]; nextRevision: number };
type Submission = { operation: Operation; undo: boolean };
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
const drawingKinds = ["strokes", "arrows", "labels"] satisfies DrawingKind[];
const clamp = (value: number) => Math.min(100_000, Math.max(-100_000, value));
const geometry = (value: number) => Math.round(clamp(value) * 100) / 100;
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
  const [strokeBounds] = useState(() => new WeakMap<Stroke, VisibleBoard["region"]>());
  const [tool, setTool] = useState<Tool>("select");
  const [keepTool, setKeepTool] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [selected, setSelected] = useState<Id>();
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
  const list = useRef<HTMLOListElement>(null);
  const listToggle = useRef<HTMLButtonElement>(null);
  const agentsToggle = useRef<HTMLButtonElement>(null);
  const selectedRef = useRef<Id>();
  const gesture = useRef<Gesture>();
  const view = useRef<View>({ x: 0, y: 0, zoom: 1 });
  const revision = useRef(info.semanticRevision);
  const undoCards = useRef<{ revision: number; changes: Change[] }[]>([]);
  const undoDrawing = useRef<DrawingEdit[]>([]);
  const redoDrawing = useRef<DrawingEdit[]>([]);
  const [initialPointCount] = useState(() => drawing.strokes.reduce((total, stroke) => total + stroke.points.length, 0));
  const points = useRef(initialPointCount);
  const semantic = useRef<Promise<void>>();
  const failed = useRef<Submission>();
  const dependency = useRef<Id>();
  const latestClose = useRef<(windowClose: boolean) => void>();
  const locked = useRef(false);
  const draftChanged = useRef(false);
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
        cards: nodeIndex, strokes: strokeBounds, dark: darkMode.matches, region: {
          left: -camera.x / camera.zoom, top: -camera.y / camera.zoom,
          right: (cssWidth - camera.x) / camera.zoom, bottom: (cssHeight - camera.y) / camera.zoom,
        },
      });
      const transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`;
      if (cardsLayer.current.style.transform !== transform) cardsLayer.current.style.transform = transform;
      if (panel.current && !panel.current.dataset.editorReady) panel.current.dataset.editorReady = "true";
    });
  }, [board, nodeIndex, strokeBounds, darkMode]);

  useEffect(() => {
    const observer = new ResizeObserver(repaint);
    if (canvas.current) observer.observe(canvas.current);
    menu.current?.querySelector("summary")?.focus();
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
    if (!mounted.current || remoteTimer.current || remoteBusy.current || gesture.current || semantic.current || locked.current || edit) return;
    remoteTimer.current = window.setTimeout(() => {
      remoteTimer.current = 0;
      remoteRefresh.current?.();
    }, 30);
  }

  remoteRefresh.current = () => {
    if (!mounted.current || !remoteNeeded.current || remoteBusy.current || gesture.current || semantic.current || locked.current || edit) return;
    remoteNeeded.current = false;
    remoteBusy.current = true;
    void invoke<DeltaPage>("board_deltas", { scope, since: revision.current })
      .then((page) => {
        if (!mounted.current) return;
        const changes = page.deltas.filter((delta) => delta.revision > revision.current);
        if (changes.length) {
          project(changes);
          undoCards.current = [];
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
            geometryChanged = true;
            break;
          }
        }
      }
      revision.current = delta.revision;
    }
    if (selectedRef.current && !nodeIndex.has(selectedRef.current)) selectCard();
    board.nodes.sort(ordered);
    update();
    if (geometryChanged) repaint();
  }

  function send(submission: Submission) {
    failed.current = undefined;
    setNotice("Saving card changes…");
    semantic.current = invoke<Receipt>("apply_operation", { scope, operation: submission.operation })
      .then((receipt) => {
        project([receipt]);
        if (submission.undo) {
          undoCards.current.pop();
          const previous = undoCards.current.at(-1);
          if (previous) previous.revision = receipt.revision;
        } else {
          undoCards.current.push({ revision: receipt.revision, changes: receipt.inverse });
          if (undoCards.current.length > 32) undoCards.current.shift();
        }
        setNotice(`Saved · revision ${receipt.revision}`);
      })
      .catch((error) => {
        failed.current = submission;
        setNotice(String(error));
      })
      .finally(() => {
        semantic.current = undefined;
        if (remoteNeeded.current) scheduleRemote();
      });
  }

  function commit(changes: Change[], undoRevision?: number) {
    if (locked.current || semantic.current || failed.current || remoteBusy.current) return false;
    send({ operation: { id: id(), expectedRevision: undoRevision ?? revision.current, changes }, undo: undoRevision !== undefined });
    return true;
  }

  function undoCard() {
    const entry = undoCards.current.at(-1);
    if (entry) commit(entry.changes, entry.revision);
  }

  function applyDrawing(edit: DrawingEdit, reverse = false) {
    const remove = edit.remove !== reverse;
    const changes = remove ? edit.changes.slice().reverse() : edit.changes;
    for (const { kind, mark, index } of changes) {
      const marks: Mark[] = drawing[kind];
      if (remove) marks.splice(index, 1);
      else marks.splice(index, 0, mark);
      if ("points" in mark) points.current += (remove ? -1 : 1) * mark.points.length;
    }
    saver.changed();
    update();
    repaint();
  }

  function changeDrawing(edit: DrawingEdit) {
    undoDrawing.current.push(edit);
    if (undoDrawing.current.length > 32) undoDrawing.current.shift();
    redoDrawing.current = [];
    applyDrawing(edit);
  }

  function addMark<K extends DrawingKind>(kind: K, mark: Drawing[K][number]) {
    changeDrawing({ remove: false, changes: [{ kind, mark, index: drawing[kind].length }] });
  }

  function undoInk(redo = false) {
    if (locked.current || gesture.current) return;
    const from = redo ? redoDrawing : undoDrawing;
    const to = redo ? undoDrawing : redoDrawing;
    const edit = from.current.pop();
    if (!edit) return;
    to.current.push(edit);
    applyDrawing(edit, !redo);
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
    event.currentTarget.focus();
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
      const card = hit(start);
      if (card && (semantic.current || failed.current)) return;
      setEdit(card ? { kind: "card", card, fresh: false } : { kind: "text", point: start });
      return;
    } else if (!semantic.current && !failed.current) {
      const card = hit(start);
      selectCard(card);
      if (tool === "connect") return connect(card);
      if (!card) return;
      const { x, y, width, height } = card;
      const resize = selected === card.id && x + width - start[0] <= 14 && y + height - start[1] <= 14;
      gesture.current = { kind: "card", start, card, before: { x, y, width, height }, resize };
    }
    if (gesture.current) event.currentTarget.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent<HTMLCanvasElement>) {
    const active = gesture.current;
    if (!active) return;
    if (active.kind === "pan") {
      const [x, y] = point(event, false);
      view.current.x = active.view.x + x - active.start[0];
      view.current.y = active.view.y + y - active.start[1];
    } else if (active.kind === "card") {
      const [x, y] = point(event);
      if (active.resize) {
        active.card.width = Math.min(4096, Math.max(48, geometry(active.before.width + x - active.start[0])));
        active.card.height = Math.min(4096, Math.max(32, geometry(active.before.height + y - active.start[1])));
      } else {
        active.card.x = geometry(active.before.x + x - active.start[0]);
        active.card.y = geometry(active.before.y + y - active.start[1]);
      }
      showCard(active.card);
    } else if (active.kind === "arrow") active.arrow.to = point(event);
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
    if (active.kind === "card") {
      const { card, before } = active;
      const moved = card.x !== before.x || card.y !== before.y || card.width !== before.width || card.height !== before.height;
      if (!canceled && moved) commit([setNode({ ...card })]);
      Object.assign(card, before);
      if (canceled || !moved) showCard(card);
      else void semantic.current?.finally(() => showCard(board.nodes.find((item) => item.id === card.id) ?? card));
    } else if (!canceled && (active.kind === "pen" || active.kind === "shape") && active.stroke.points.length >= 2) {
      addMark("strokes", active.stroke);
      if (active.kind === "shape" && !keepTool) setTool("select");
    } else if (!canceled && active.kind === "arrow" &&
      (active.arrow.from[0] !== active.arrow.to[0] || active.arrow.from[1] !== active.arrow.to[1])) {
      addMark("arrows", active.arrow);
      if (!keepTool) setTool("select");
    } else if (!canceled && active.kind === "eraser" && active.removed.size) {
      const changes: DrawingChange[] = [];
      for (const kind of drawingKinds) {
        drawing[kind].forEach((mark, index) => {
          if (active.removed.has(mark)) changes.push({ kind, mark, index });
        });
      }
      changeDrawing({ remove: true, changes });
    }
    repaint();
    if (remoteNeeded.current) scheduleRemote();
  }

  function addCard() {
    if (edit || locked.current || gesture.current || semantic.current || failed.current || remoteBusy.current) return;
    const camera = view.current;
    const shift = 32 * (board.nodes.length % 7);
    const at: Point = [geometry((70 + shift - camera.x) / camera.zoom), geometry((90 + shift - camera.y) / camera.zoom)];
    setEdit({ kind: "card", card: makeCard("", at, (board.nodes.at(-1)?.order ?? -1) + 1), fresh: true });
  }

  function enterEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!edit || locked.current) return;
    const values = new FormData(event.currentTarget);
    const text = String(values.get("title")).trim();
    if (!text) return;
    if (new TextEncoder().encode(text).length > 1024) return setNotice("Enter a title of 1–1024 bytes.");
    if (edit.kind === "text") {
      if (drawing.labels.length >= 1_000) return setNotice("This board reached its text limit.");
      addMark("labels", { x: edit.point[0], y: edit.point[1], text });
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
      commit([setNode(card)]);
      selectCard(card);
    }
    draftChanged.current = false;
    setEdit(undefined);
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
      setEdit({ kind: "card", card, fresh: false });
    }
  }

  function selectCard(card?: Card, reveal = false) {
    selectedRef.current = card?.id;
    setSelected(card?.id);
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
    draftChanged.current = false;
    setEdit(undefined);
  }

  function closePanel(id: "cards" | "agents") {
    if (id === "cards") setInspector(false);
    else setAgents(false);
    (id === "cards" ? listToggle : agentsToggle).current?.focus();
  }

  function selectTool(next: Tool) {
    setTool(next);
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
    if (event.key === "Escape") {
      if (gesture.current) finish(true);
      else if (closeDisclosure(menu.current) || closeDisclosure(moreTools.current)) {
        event.preventDefault();
        return;
      }
      else if (agents) closePanel("agents");
      else if (inspector) closePanel("cards");
      else if (event.target === canvas.current) {
        dependency.current = undefined;
        selectCard();
        setNotice("");
      } else return;
      event.preventDefault();
      return;
    }
    if (event.target !== canvas.current || locked.current) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) undoInk();
      else undoCard();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const shortcut = event.key.toLowerCase();
    const next = tools.find((item) => item.key === shortcut || item.number === shortcut);
    if (next && next.id !== "image") {
      event.preventDefault();
      selectTool(next.id);
      return;
    }
    if (shortcut === "q" || shortcut === "?") {
      event.preventDefault();
      if (shortcut === "q") setKeepTool(!keepTool);
      else setKeyboardHelp(true);
      return;
    }
    const arrows = ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"];
    if (arrows.includes(event.key)) {
      event.preventDefault();
      if (tool === "pan") {
        const direction = arrows.indexOf(event.key);
        if (direction % 2) view.current.y += direction === 1 ? 64 : -64;
        else view.current.x += direction === 0 ? 64 : -64;
        repaint();
      } else if (board.nodes.length) {
        const index = board.nodes.findIndex((item) => item.id === selectedRef.current);
        const direction = arrows.indexOf(event.key) < 2 ? -1 : 1;
        const next = index === -1 ? 0 : (index + direction + board.nodes.length) % board.nodes.length;
        selectCard(board.nodes[next], true);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      const selectedCard = board.nodes.find((item) => item.id === selectedRef.current);
      if (tool === "connect") connect(selectedCard);
      else if (selectedCard) editCard(selectedCard);
    } else if (event.key === "Insert" || shortcut === "n") {
      event.preventDefault();
      addCard();
    } else if (event.key === " ") {
      event.preventDefault();
      space.current = true;
    } else if (event.key === "+" || event.key === "=" || event.key === "-") {
      event.preventDefault();
      zoom(event.key === "-" ? 1 / 1.1 : 1.1);
    }
  }

  const card = board.nodes.find((item) => item.id === selected);
  const group = card && board.nodes.find((item) => item.id === card.parent);
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
          <button type="button" disabled={pending || !undoCards.current.length}
            onClick={() => { closeDisclosure(menu.current); undoCard(); }}><Icon name="undo" size={16} />Undo card</button>
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
      <p id="board-keyboard-summary" className="visually-hidden">Arrow keys select cards. Enter edits the selected card or links it in Dependency mode.</p>
      <div role="status" aria-atomic="true" className="visually-hidden">{card ? `Selected ${card.title}` : ""}</div>
      <canvas ref={canvas} className={`interactive lean-canvas tool-${tool}`} data-board-surface tabIndex={0}
        aria-label="Drawing canvas" aria-describedby="board-keyboard-summary"
        onPointerDown={start} onPointerMove={move} onPointerUp={() => finish(false)} onPointerCancel={() => finish(true)}
        onLostPointerCapture={() => finish(true)}
        onDoubleClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const camera = view.current;
          const card = hit([(event.clientX - rect.left - camera.x) / camera.zoom, (event.clientY - rect.top - camera.y) / camera.zoom]);
          if (card && tool === "select") editCard(card);
        }} />
      <div className="lean-cards" aria-hidden="true" ref={cardsLayer}>
        {board.nodes.map((item) => (
          <div key={item.id} dir="auto" className="lean-card" data-card-id={item.id}
            data-kind={item.kind} data-status={item.status} data-priority={item.priority} data-dropped={item.dropped}
            data-badge={item.dropped ? "Dropped" : statuses[item.status]}
            data-selected={selected === item.id}
            ref={(element) => { if (element) cards.current.set(item.id, element); else cards.current.delete(item.id); }}
            style={{ left: item.x, top: item.y, width: item.width, height: item.height }}
            onClick={() => tool === "connect" ? connect(item) : editCard(item)}>
            <span className="card-title">{item.title}</span>
          </div>
        ))}
        {drawing.labels.map((label, index) => <span className="lean-label" dir="auto" key={index} style={{ left: label.x, top: label.y }}>{label.text}</span>)}
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
            <button type="button" data-tool="connect" disabled={pending} aria-pressed={tool === "connect"}
              onClick={() => { selectTool("connect"); closeDisclosure(moreTools.current); }}>
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
        <div className="lean-history board-control" role="group" aria-label="Drawing history">
          <button type="button" disabled={pending || !undoDrawing.current.length} onClick={() => undoInk()} title="Undo drawing">
            <Icon name="undo" size={16} /><span className="visually-hidden">Undo drawing</span>
          </button>
          <button type="button" disabled={pending || !redoDrawing.current.length} onClick={() => undoInk(true)} title="Redo drawing">
            <Icon name="redo" size={16} /><span className="visually-hidden">Redo drawing</span>
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
      {!agents && (inspector || card) && <div className="lean-shelf">
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
          <li key={item.id}><button dir="auto" type="button" data-status={item.status} aria-pressed={selected === item.id}
            tabIndex={(card ? card.id === item.id : index === 0) ? 0 : -1}
            onClick={() => { selectCard(item, true); if (tool === "connect") connect(item); }}>{item.title}</button></li>
        ))}</ol>
      </aside>}
      {card && <aside className="lean-selection" aria-label="Selected card">
        <strong dir="auto">{card.title}</strong>
        <small>{kinds[card.kind]} · {statuses[card.status]} · {priorities[card.priority]}{group && ` · ${group.title}`}</small>
        {card.kind === "task" && <small>Status source {card.statusSource ? "paired client" : "local editor"}</small>}
        <div>
          <button type="button" onClick={() => editCard(card)}>Edit card</button>
          <button type="button" disabled={pending} onClick={() => commit([setNode({ ...card, dropped: !card.dropped })])}>{card.dropped ? "Restore" : "Drop"}</button>
          <button type="button" disabled={pending} onClick={() => reorder(card, -1)}>Move earlier</button>
          <button type="button" disabled={pending} onClick={() => reorder(card, 1)}>Move later</button>
        </div>
        {board.edges.filter((edge) => edge.from === card.id || edge.to === card.id).map((edge) => (
          <div key={edge.id}>
            <span dir="auto">{edge.from === card.id ? "Required by " : "Requires "}{board.nodes.find((item) => item.id === (edge.from === card.id ? edge.to : edge.from))?.title}</span>
            <button type="button" disabled={pending} onClick={() => commit([{ type: "removeEdge", id: edge.id }])}>Remove link</button>
          </div>
        ))}
      </aside>}
      </div>}
      {keyboardHelp && <Modal title="Board shortcuts" cancel={() => setKeyboardHelp(false)}>
        <h2>Board shortcuts</h2>
        <dl className="board-shortcuts">
          <dt>Arrow keys</dt><dd>Select a card, or pan in Pan mode.</dd>
          <dt>Enter</dt><dd>Edit the selected card, or link two cards in Dependency mode.</dd>
          <dt>N / Insert</dt><dd>Add a card.</dd>
          <dt>Plus / minus</dt><dd>Zoom in or out.</dd>
          <dt>Ctrl / Cmd + Z</dt><dd>Undo the last card change.</dd>
          <dt>Ctrl / Cmd + Shift + Z</dt><dd>Undo the last drawing change.</dd>
          <dt>Escape</dt><dd>Cancel a gesture or close the active panel.</dd>
        </dl>
        <button type="button" data-initial-focus onClick={() => setKeyboardHelp(false)}>Close shortcuts</button>
      </Modal>}
      {edit && <Modal title={edit.kind === "text" ? "Place text" : edit.fresh ? "Add card" : "Edit card"} cancel={cancelEdit}>
        <h2>{edit.kind === "text" ? "Place text" : edit.fresh ? "Add card" : "Edit card"}</h2>
        <form className="lean-edit" onSubmit={enterEdit} onChange={() => { draftChanged.current = true; }}>
        <label>{edit.kind === "card" ? "Title" : "Board text"}
          <textarea name="title" dir="auto" data-initial-focus required
            className={edit.kind === "text" ? "lean-note-input" : undefined}
            defaultValue={edit.kind === "card" ? edit.card.title : ""} maxLength={512} />
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
          <button type="submit" disabled={pending}>{edit.kind === "card" ? edit.fresh ? "Create card" : "Save card" : "Place text"}</button>
        </div>
        </form>
      </Modal>}
      <div className="lean-status" data-visible={!!(notice || failed.current || saveState.failed || saveState.pending)}>
        {notice ? <output data-card-save="">{notice}</output> : <span className="visually-hidden">Revision {revision.current}</span>}
        <output data-drawing-save="" className={saveState.failed || saveState.pending ? undefined : "visually-hidden"}>{saveState.message}</output>
        {failed.current && <div><button type="button" disabled={pending} onClick={() => { if (failed.current) send(failed.current); }}>Retry card change</button>
          <button type="button" disabled={pending} onClick={() => { failed.current = undefined; setNotice(""); }}>Dismiss card change</button></div>}
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
