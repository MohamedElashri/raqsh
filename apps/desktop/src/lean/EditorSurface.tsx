import "./excalidraw-assets";
import { CaptureUpdateAction, Excalidraw, FONT_FAMILY } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useLayoutEffect, useState, useRef, type MutableRefObject } from "react";
import type { ExcalidrawElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI, UIOptions } from "@excalidraw/excalidraw/types";
import type { Card, Change, Id, Point } from "../model";
import type { Board, View } from "./board";
import { drawingKinds, emptySelection, geometry, removeSelection, topmost, type Mark, type MarkChange, type Selection } from "./editing";
import { cardElements, cardId, edgeId, markElement, penWidthScale, readMark } from "./scene";

const options: UIOptions = {
  canvasActions: { export: false, saveAsImage: false, loadScene: false, saveToActiveFile: false,
    clearCanvas: false, toggleTheme: false, changeViewBackgroundColor: false },
  tools: { image: false },
};

export type Tool = "select" | "pan" | "pen" | "text" | "arrow" | "connect" | "eraser" | "rectangle" | "diamond" | "ellipse" | "line";
const toolTypes = {
  select: "selection", pan: "hand", pen: "freedraw", text: "text", arrow: "arrow", connect: "selection",
  eraser: "eraser", rectangle: "rectangle", diamond: "diamond", ellipse: "ellipse", line: "line",
} as const;

type Props = {
  board: Board;
  container: MutableRefObject<HTMLDivElement | null>;
  cardsLayer: MutableRefObject<HTMLDivElement | null>;
  cards: MutableRefObject<Map<Id, HTMLDivElement>>;
  active: MutableRefObject<boolean>;
  controller: MutableRefObject<ExcalidrawImperativeAPI | null>;
  sync: MutableRefObject<(() => void) | undefined>;
  selection: Selection;
  view: MutableRefObject<View>;
  tool: Tool;
  keepTool: boolean;
  dark: boolean;
  readOnly: boolean;
  canEdit: () => boolean;
  onReady: () => void;
  onView: (zoom: number) => void;
  onTool: (tool: Tool) => void;
  onSelection: (selection: Selection) => void;
  onEditCard: (card: Card) => void;
  onConnect: (card: Card) => void;
  onSettle: () => void;
  onNotice: (message: string) => void;
  onCommit: (changes: Change[], marks: MarkChange[], selection: Selection) => boolean;
};

type Entry = { element: ExcalidrawElement; version: number };
const snapshot = (element: ExcalidrawElement): Entry => ({ element, version: element.versionNonce });
const sameSelection = (left: Selection, right: Selection) => (["cards", "edges", "marks"] as const)
  .every((kind) => left[kind].size === right[kind].size && Array.from<Id | Mark>(left[kind]).every((key) =>
    (right[kind] as Set<Id | Mark>).has(key)));

export default function EditorSurface(props: Props) {
  const current = useRef(props);
  current.current = props;
  const { board, active, controller } = props;
  const marks = useRef(new WeakMap<Mark, Entry>());
  const typed = useRef(new Map<string, Entry>());
  const nextMark = useRef(0);
  const nextProjection = useRef(0);
  const drawingFrame = useRef(0);
  const pointer = useRef(false);
  const initialized = useRef(false);
  const typedGeometry = useRef("");
  const nativeTool = useRef("");
  const synchronizedTool = useRef<Tool>();
  const lastZoom = useRef(100);
  const published = useRef<readonly object[][]>([]);
  const modelParts = () => [board.nodes, board.edges, board.strokes, board.arrows, board.labels];
  const modelChanged = () => modelParts().some((part, index) =>
    part.length !== published.current[index]?.length || part.some((item, slot) => item !== published.current[index][slot]));

  function projected() {
    const signature = board.nodes.map(({ id, x, y, width, height }) => [id, x, y, width, height].join(":"))
      .concat(board.edges.map(({ id, from, to, kind }) => [id, from, to, kind].join(":"))).join("|");
    if (signature !== typedGeometry.current) {
      typedGeometry.current = signature;
      typed.current = new Map(cardElements(board.nodes, board.edges).map((element) => {
        const next = { ...element, versionNonce: ++nextProjection.current };
        return [next.id, snapshot(next)];
      }));
    }
    return [...Array.from(typed.current.values(), ({ element }) => element),
      ...drawingKinds.flatMap((kind) => board[kind].map((mark) => {
        let entry = marks.current.get(mark);
        if (!entry) {
          entry = snapshot(markElement(mark, `raqsh-mark-${nextMark.current++}`));
          marks.current.set(mark, entry);
        }
        return entry.element;
      }))];
  }

  const [initial] = useState(() => () => ({ elements: projected().map((element) => structuredClone(element)),
    appState: { currentItemFontFamily: FONT_FAMILY.Excalifont, currentItemFontSize: 17, currentItemRoughness: 0,
      currentItemStrokeColor: "#1b1b19", currentItemStrokeWidth: 2, currentItemRoundness: "sharp" as const, isBindingEnabled: false } }));

  function acceptProjection(elements: readonly ExcalidrawElement[]) {
    // Excalidraw may assign new ordering indices and nonces on import or updateScene.
    const byId = new Map(elements.map((element) => [element.id, element]));
    for (const [key, entry] of typed.current) {
      const saved = byId.get(key);
      if (saved && saved.versionNonce !== entry.version) typed.current.set(key, snapshot(structuredClone(saved)));
    }
    for (const kind of drawingKinds) {
      for (const mark of board[kind]) {
        const entry = marks.current.get(mark);
        const saved = entry && byId.get(entry.element.id);
        if (saved && saved.versionNonce !== entry.version) marks.current.set(mark, snapshot(structuredClone(saved)));
      }
    }
  }

  function selectionOf(selected: AppState["selectedElementIds"]): Selection {
    const next = emptySelection();
    for (const card of board.nodes) if (selected[cardId(card.id)]) next.cards.add(card.id);
    for (const edge of board.edges) if (selected[edgeId(edge.id)]) next.edges.add(edge.id);
    for (const kind of drawingKinds) {
      for (const mark of board[kind]) {
        const entry = marks.current.get(mark);
        if (entry && selected[entry.element.id]) next.marks.add(mark);
      }
    }
    return next;
  }

  function sync(force = false) {
    const api = controller.current;
    if (!api || !initialized.current) return;
    if (!force && active.current) return;
    const { tool, keepTool, selection } = current.current;
    const state = api.getAppState();
    if (synchronizedTool.current !== tool || state.activeTool.locked !== keepTool) {
      synchronizedTool.current = tool;
      nativeTool.current = toolTypes[tool];
      api.setActiveTool({ type: toolTypes[tool], locked: keepTool });
      api.updateScene({ appState: { currentItemStrokeWidth: tool === "pen" ? 2 / penWidthScale : 2 },
        captureUpdate: CaptureUpdateAction.NEVER });
    }
    if (!force && drawingFrame.current && !modelChanged()) return;
    const elements = projected();
    published.current = modelParts().map((part) => [...part]);
    const live = api.getSceneElements();
    const liveById = new Map(live.map((element) => [element.id, element]));
    const changed = elements.length !== live.length || elements.some((element) => {
      const prev = liveById.get(element.id);
      return !prev || prev.versionNonce !== element.versionNonce;
    });
    const selected = Object.fromEntries([
      ...Array.from(selection.cards, cardId),
      ...Array.from(selection.edges, edgeId),
      ...Array.from(selection.marks).flatMap((mark) => {
        const entry = marks.current.get(mark);
        return entry ? [entry.element.id] : [];
      }),
    ].map((key) => [key, true] as const));
    const same = Object.keys(selected).length === Object.keys(state.selectedElementIds).length
      && Object.keys(selected).every((key) => state.selectedElementIds[key]);
    const viewBackgroundColor = "transparent";
    if (changed || !same || state.viewBackgroundColor !== viewBackgroundColor) {
      api.updateScene({ elements: changed ? elements.map((element) => liveById.get(element.id)?.versionNonce === element.versionNonce
        ? liveById.get(element.id)! : structuredClone(element)) : undefined,
        appState: { selectedElementIds: selected, viewBackgroundColor }, captureUpdate: CaptureUpdateAction.NEVER });
      if (changed) acceptProjection(api.getSceneElements());
    }
  }

  function settle() {
    cancelAnimationFrame(drawingFrame.current);
    drawingFrame.current = 0;
    const api = controller.current;
    if (!api || !initialized.current) return;
    const state = api.getAppState();
    active.current = pointer.current || !!(state.newElement || state.multiElement || state.editingTextElement);
    if (active.current) return;
    // The native scene can still describe the preceding revision just after an IPC receipt or Undo.
    if (modelChanged()) {
      sync(true);
      return;
    }
    const { readOnly, canEdit, onCommit, onNotice, onSettle, onSelection, selection } = current.current;
    if (readOnly || !canEdit()) { onSettle(); return; }
    const live = new Map(api.getSceneElements().map((element) => [element.id, element]));
    const selected = selectionOf(state.selectedElementIds);
    const removed = emptySelection();
    const changes: Change[] = [];
    const marksChanged: MarkChange[] = [];
    let invalid = false;
    for (const card of board.nodes) {
      const key = cardId(card.id);
      const element = live.get(key);
      live.delete(key);
      if (!element) removed.cards.add(card.id);
      else if (element.versionNonce !== typed.current.get(key)?.version) {
        const { x, y, width, height, angle } = element;
        if (angle || element.type !== "rectangle") invalid = true;
        const next = { ...card, x: geometry(x), y: geometry(y), width: Math.max(48, Math.min(4096, geometry(width))),
          height: Math.max(32, Math.min(4096, geometry(height))) };
        if (next.x !== card.x || next.y !== card.y || next.width !== card.width || next.height !== card.height) {
          changes.push({ type: "setNode", node: next });
        }
      }
    }
    for (const edge of board.edges) {
      if (!live.delete(edgeId(edge.id))) removed.edges.add(edge.id);
    }
    const deletions = removeSelection(board, removed).changes;
    const regrouped = new Map(deletions.flatMap((change) => change.type === "setNode" ? [[change.node.id, change.node] as const] : []));
    const moved = new Set(changes.flatMap((change) => change.type === "setNode" ? [change.node.id] : []));
    for (const change of changes) {
      if (change.type === "setNode" && regrouped.has(change.node.id)) change.node.parent = null;
    }
    changes.push(...deletions.filter((change) => change.type !== "setNode" || !moved.has(change.node.id)));
    for (const key of removed.cards) selected.cards.delete(key);
    for (const key of removed.edges) selected.edges.delete(key);
    const counts = { strokes: board.strokes.length, arrows: board.arrows.length, labels: board.labels.length };
    let points = board.strokes.reduce((sum, mark) => sum + mark.points.length, 0);
    for (const kind of drawingKinds) {
      for (let index = board[kind].length - 1; index >= 0; index--) {
        const before = board[kind][index];
        const entry = marks.current.get(before)!;
        const key = entry.element.id;
        const element = live.get(key);
        live.delete(key);
        if (element?.versionNonce === entry.version) continue;
        if (!element) {
          counts[kind]--;
          if ("points" in before) points -= before.points.length;
          selected.marks.delete(before);
          marksChanged.push({ kind, index, before });
        } else {
          const updated = readMark(element, before);
          if (updated?.kind !== kind) { invalid = true; continue; }
          const after = updated.mark;
          if ("points" in after && "points" in before) points += after.points.length - before.points.length;
          if (selected.marks.delete(before)) selected.marks.add(after);
          marks.current.set(after, snapshot(structuredClone(element)));
          marksChanged.push({ kind, index, before, after });
        }
      }
    }
    for (const element of live.values()) {
      // Native duplication and the clipboard can assign a new ID to a card proxy.
      if (element.customData?.raqshCard || element.id.startsWith("raqsh-card-")) { invalid = true; continue; }
      const converted = readMark(element);
      if (!converted) { invalid = true; continue; }
      const { kind, mark: after } = converted;
      marksChanged.push({ kind, index: counts[kind]++, after });
      marks.current.set(after, snapshot(structuredClone(element)));
      if (state.selectedElementIds[element.id]) selected.marks.add(after);
      if ("points" in after) points += after.points.length;
    }
    const overLimit = counts.strokes > 2_000 || counts.labels > 1_000 || counts.arrows > 1_000 || points > 180_000;
    if (invalid || overLimit) {
      onNotice(overLimit ? "This board reached its drawing limit." : "This edit cannot be saved in the current board format.");
      sync(true);
    } else if (changes.length || marksChanged.length) {
      if (!onCommit(changes, marksChanged, selected)) sync(true);
    } else {
      if (!sameSelection(selected, selection)) onSelection(selected);
    }
    onSettle();
  }

  function queueSettle() {
    if (!drawingFrame.current) drawingFrame.current = requestAnimationFrame(settle);
  }

  function change(elements: readonly OrderedExcalidrawElement[], state: AppState) {
    if (state.isLoading) return;
    const { cards, cardsLayer, container, view, onView, onTool } = current.current;
    const zoom = state.zoom.value;
    view.current = { x: state.scrollX * zoom, y: state.scrollY * zoom, zoom };
    if (cardsLayer.current) cardsLayer.current.style.transform = `translate(${view.current.x}px, ${view.current.y}px) scale(${zoom})`;
    const rounded = Math.round(zoom * 100);
    if (rounded !== lastZoom.current) {
      lastZoom.current = rounded;
      onView(rounded);
    }
    for (const element of elements) {
      const card = element.customData?.raqshCard;
      const item = typeof card === "string" ? cards.current.get(card) : undefined;
      if (!item || element.isDeleted) continue;
      item.style.left = `${element.x}px`;
      item.style.top = `${element.y}px`;
      item.style.width = `${element.width}px`;
      item.style.height = `${element.height}px`;
    }
    if (!initialized.current) {
      acceptProjection(elements);
      initialized.current = true;
      if (container.current) {
        current.current.onReady();
        container.current.querySelector<HTMLElement>(".excalidraw")?.focus({ preventScroll: true });
      }
      sync(true);
    } else if (state.activeTool.type !== nativeTool.current) {
      const tool = (Object.keys(toolTypes) as Tool[]).find((key) => toolTypes[key] === state.activeTool.type);
      if (tool) {
        nativeTool.current = state.activeTool.type;
        synchronizedTool.current = tool;
        onTool(tool);
      }
    }
    active.current = pointer.current || !!(state.newElement || state.multiElement || state.editingTextElement);
    if (!active.current) queueSettle();
  }

  useLayoutEffect(() => {
    props.sync.current = settle;
    sync();
  });
  useLayoutEffect(() => () => cancelAnimationFrame(drawingFrame.current), []);

  function hit(clientX: number, clientY: number): Card | undefined {
    const rect = current.current.container.current?.getBoundingClientRect();
    if (!rect) return;
    const { x, y, zoom } = current.current.view.current;
    const px = (clientX - rect.left - x) / zoom;
    const py = (clientY - rect.top - y) / zoom;
    return topmost(board.nodes, (card) => px >= card.x && py >= card.y && px <= card.x + card.width && py <= card.y + card.height);
  }

  return <div className={`lean-canvas excalidraw-surface tool-${props.tool}`} ref={props.container}
    data-board-surface role="region" aria-label="Drawing canvas" aria-describedby="board-keyboard-summary"
    onDropCapture={(event) => { event.preventDefault(); event.stopPropagation(); }}
    onContextMenuCapture={(event) => { event.preventDefault(); event.stopPropagation(); }}
    onPointerDownCapture={(event) => {
      if (event.button !== 0) return;
      if (!props.canEdit()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (props.tool !== "connect" || props.readOnly) return;
      event.preventDefault();
      event.stopPropagation();
      const card = hit(event.clientX, event.clientY);
      if (card) props.onConnect(card);
    }}
    onDoubleClickCapture={(event) => {
      const card = props.tool === "select" ? hit(event.clientX, event.clientY) : undefined;
      if (!card) return;
      event.preventDefault();
      event.stopPropagation();
      props.onEditCard(card);
    }}>
    <Excalidraw excalidrawAPI={(api) => { controller.current = api; }} initialData={initial} onChange={change}
      UIOptions={options} theme={props.dark ? "dark" : "light"} viewModeEnabled={props.readOnly}
      aiEnabled={false} validateEmbeddable={false} onLinkOpen={(_, event) => event.preventDefault()}
      onPaste={(data) => !data.files && !data.elements && !data.spreadsheet}
      autoFocus onPointerDown={() => { pointer.current = active.current = true; }}
      onPointerUp={() => { pointer.current = false; queueSettle(); }} />
  </div>;
}
