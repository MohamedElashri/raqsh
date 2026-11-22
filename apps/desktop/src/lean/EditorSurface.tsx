import "./excalidraw-assets";
import { CaptureUpdateAction, convertToExcalidrawElements, Excalidraw, FONT_FAMILY, getDataURL, isElementLink } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useLayoutEffect, useState, useRef, type MutableRefObject } from "react";
import type { ExcalidrawElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFileData, ExcalidrawImperativeAPI, LibraryItems, UIOptions } from "@excalidraw/excalidraw/types";
import { id, type Card, type Change, type ExcalidrawScene, type Id } from "../model";
import type { Board, View } from "./board";
import { emptySelection, geometry, removeSelection, topmost } from "./editing";
import { cardElements, cardId, composeScene, edgeId, isTypedId, penWidthScale, sceneAppState, snapshotScene } from "./scene";

const libraryKey = "raqsh.excalidraw.library";

function openDrawingLibrary(): LibraryItems {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(libraryKey) ?? "[]");
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

const options: UIOptions = {
  canvasActions: { export: false, saveAsImage: false, loadScene: false, saveToActiveFile: false,
    clearCanvas: false, toggleTheme: false },
  tools: { image: true },
};

const toolTypes = {
  select: "selection", pan: "hand", pen: "freedraw", text: "text", arrow: "arrow", connect: "selection",
  eraser: "eraser", rectangle: "rectangle", diamond: "diamond", ellipse: "ellipse", line: "line",
  image: "image", frame: "frame", laser: "laser",
} as const;
export type Tool = keyof typeof toolTypes;
export type BoardSelection = { cards: Set<Id>; edges: Set<Id>; elements: Set<string> };
export const blankSelection = (): BoardSelection => ({ cards: new Set(), edges: new Set(), elements: new Set() });
export const countSelection = (selection: BoardSelection) => selection.cards.size + selection.edges.size + selection.elements.size;

type Props = {
  board: Board;
  scene: ExcalidrawScene;
  container: MutableRefObject<HTMLDivElement | null>;
  cardsLayer: MutableRefObject<HTMLDivElement | null>;
  cards: MutableRefObject<Map<Id, HTMLDivElement>>;
  active: MutableRefObject<boolean>;
  controller: MutableRefObject<ExcalidrawImperativeAPI | null>;
  sync: MutableRefObject<(() => void) | undefined>;
  selection: BoardSelection;
  view: MutableRefObject<View>;
  tool: Tool;
  keepTool: boolean;
  dark: boolean;
  readOnly: boolean;
  canEdit: () => boolean;
  onReady: () => void;
  onView: (zoom: number) => void;
  onTool: (tool: Tool) => void;
  onSelection: (selection: BoardSelection) => void;
  onEditCard: (card: Card) => void;
  onConnect: (card: Card) => void;
  onSettle: () => void;
  onNotice: (message: string) => void;
  onCommit: (changes: Change[], scene: ExcalidrawScene | undefined, selection: BoardSelection) => boolean;
};

const sameSelection = (left: BoardSelection, right: BoardSelection) => (["cards", "edges", "elements"] as const)
  .every((kind) => left[kind].size === right[kind].size && [...left[kind]].every((id) => right[kind].has(id)));

export default function EditorSurface(props: Props) {
  const current = useRef(props);
  current.current = props;
  const { board, active, controller } = props;
  const drawingFrame = useRef(0);
  const pointer = useRef(false);
  const initialized = useRef(false);
  const typedGeometry = useRef<string>();
  const typed = useRef<readonly ExcalidrawElement[]>([]);
  const model = useRef<ExcalidrawScene>();
  const settled = useRef(props.scene);
  const typedVersions = useRef(new Map<string, number>());
  const nativeTool = useRef("");
  const synchronizedTool = useRef<Tool>();
  const lastZoom = useRef(100);

  function geometryKey() {
    return board.nodes.map(({ id, x, y, width, height }) => [id, x, y, width, height].join(":"))
      .concat(board.edges.map(({ id, from, to, kind }) => [id, from, to, kind].join(":"))).join("|");
  }

  const [initial] = useState(() => () => {
    typedGeometry.current = geometryKey();
    typed.current = cardElements(board.nodes, board.edges);
    return {
      elements: structuredClone(composeScene(typed.current, props.scene)),
      files: props.scene.files,
      libraryItems: openDrawingLibrary(),
      appState: { ...sceneAppState(props.scene), currentItemFontFamily: FONT_FAMILY.Excalifont,
        currentItemFontSize: 17, currentItemRoughness: 0, currentItemStrokeColor: "#1b1b19",
        currentItemStrokeWidth: 2, currentItemRoundness: "sharp" as const },
    };
  });

  function acceptProjection(api: ExcalidrawImperativeAPI, state = api.getAppState()) {
    const elements = api.getSceneElements();
    typedVersions.current = new Map(elements.filter((element) => isTypedId(element.id))
      .map((element) => [element.id, element.versionNonce]));
    settled.current = snapshotScene(current.current.scene, elements, api.getFiles(), state);
  }

  function sync(force = false) {
    const api = controller.current;
    if (!api || !initialized.current || (!force && active.current)) return;
    const { tool, keepTool, selection, scene } = current.current;
    const state = api.getAppState();
    if (synchronizedTool.current !== tool || state.activeTool.locked !== keepTool) {
      const toolChanged = synchronizedTool.current !== tool;
      synchronizedTool.current = tool;
      nativeTool.current = toolTypes[tool];
      api.setActiveTool({ type: toolTypes[tool], locked: keepTool });
      if (toolChanged && tool === "pen") api.updateScene({
        appState: { currentItemStrokeWidth: 2 / penWidthScale }, captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    const signature = geometryKey();
    const changed = model.current !== scene || typedGeometry.current !== signature;
    if (!changed && !force && drawingFrame.current) return;
    if (typedGeometry.current !== signature) {
      typedGeometry.current = signature;
      typed.current = cardElements(board.nodes, board.edges);
    }
    const selected = Object.fromEntries([
      ...Array.from(selection.cards, cardId), ...Array.from(selection.edges, edgeId), ...selection.elements,
    ].map((key) => [key, true] as const));
    const same = Object.keys(selected).length === Object.keys(state.selectedElementIds).length
      && Object.keys(selected).every((key) => state.selectedElementIds[key]);
    model.current = scene;
    if (changed || force) {
      const loaded = api.getFiles();
      const files = Object.values(scene.files).filter((file) => loaded[file.id]?.dataURL !== file.dataURL);
      if (files.length) api.addFiles(files);
      api.updateScene({ elements: structuredClone(composeScene(typed.current, scene)),
        appState: { ...sceneAppState(scene), selectedElementIds: selected }, captureUpdate: CaptureUpdateAction.NEVER });
      acceptProjection(api, { ...state, ...sceneAppState(scene) });
    } else if (!same) {
      api.updateScene({ appState: { selectedElementIds: selected }, captureUpdate: CaptureUpdateAction.NEVER });
    }
  }

  function settle() {
    cancelAnimationFrame(drawingFrame.current);
    drawingFrame.current = 0;
    const api = controller.current;
    if (!api || !initialized.current) return;
    const state = api.getAppState();
    active.current = pointer.current || !!(state.newElement || state.multiElement || state.editingTextElement || state.pendingImageElementId);
    if (active.current) return;
    const { readOnly, canEdit, onCommit, onNotice, onSettle, onSelection, selection, scene } = current.current;
    if (readOnly || !canEdit()) return;
    if (model.current !== scene || typedGeometry.current !== geometryKey()) {
      sync(true);
      onSettle();
      return;
    }
    const elements = api.getSceneElements();
    const live = new Map(elements.map((element) => [element.id, element]));
    const selected = blankSelection();
    const removed = emptySelection();
    const moved = new Map<Id, Card>();
    let resetTyped = false;
    for (const card of board.nodes) {
      const key = cardId(card.id);
      const element = live.get(key);
      if (!element) { removed.cards.add(card.id); continue; }
      if (state.selectedElementIds[key]) selected.cards.add(card.id);
      if (element.versionNonce === typedVersions.current.get(key)) continue;
      const { x, y, width, height, angle } = element;
      // The Rust graph owns card geometry and styling. A proxy can only move or resize.
      if (angle || element.type !== "rectangle") { resetTyped = true; continue; }
      const next = { ...card, x: geometry(x), y: geometry(y), width: Math.max(48, Math.min(4096, geometry(width))),
        height: Math.max(32, Math.min(4096, geometry(height))) };
      if (next.x !== card.x || next.y !== card.y || next.width !== card.width || next.height !== card.height) {
        moved.set(card.id, next);
      } else {
        const template = typed.current.find((candidate) => candidate.id === key)!;
        resetTyped ||= element.opacity !== 0 || element.locked || !!element.groupIds.length
          || !!element.frameId || element.strokeColor !== template.strokeColor || element.backgroundColor !== template.backgroundColor;
        if (!resetTyped) typedVersions.current.set(key, element.versionNonce);
      }
    }
    for (const edge of board.edges) {
      const key = edgeId(edge.id);
      if (!live.has(key)) removed.edges.add(edge.id);
      else if (state.selectedElementIds[key]) selected.edges.add(edge.id);
    }
    const changes = removeSelection(board, removed).changes.map((change) => {
      if (change.type !== "setNode") return change;
      const next = moved.get(change.node.id);
      if (!next) return change;
      moved.delete(next.id);
      return { type: "setNode", node: { ...next, parent: change.node.parent } } as const;
    });
    for (const node of moved.values()) changes.unshift({ type: "setNode", node });
    const next = snapshotScene(settled.current, elements, api.getFiles(), state);
    for (const element of next.elements) if (state.selectedElementIds[element.id]) selected.elements.add(element.id);
    if (changes.length || next !== settled.current) {
      if (!onCommit(changes, next === settled.current ? undefined : next, selected)) sync(true);
      else if (!changes.length && !resetTyped) {
        model.current = next;
        settled.current = next;
      }
    } else {
      if (!sameSelection(selected, selection)) onSelection(selected);
      if (resetTyped) {
        onNotice("Task cards use the board's card style.");
        sync(true);
      }
    }
    api.history.clear();
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
      const item = typeof card === "string" && element.id === cardId(card) ? cards.current.get(card) : undefined;
      if (!item || element.isDeleted) continue;
      item.style.left = `${element.x}px`;
      item.style.top = `${element.y}px`;
      item.style.width = `${element.width}px`;
      item.style.height = `${element.height}px`;
    }
    active.current = pointer.current || !!(state.newElement || state.multiElement || state.editingTextElement || state.pendingImageElementId);
    if (!initialized.current && controller.current) {
      initialized.current = true;
      model.current = current.current.scene;
      acceptProjection(controller.current);
      current.current.onReady();
      container.current?.querySelector<HTMLElement>(".excalidraw")?.focus({ preventScroll: true });
      sync();
    } else if (state.activeTool.type !== nativeTool.current) {
      const tool = (Object.keys(toolTypes) as Tool[]).find((key) => toolTypes[key] === state.activeTool.type);
      if (tool) {
        nativeTool.current = state.activeTool.type;
        synchronizedTool.current = tool;
        onTool(tool);
      }
    }
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

  async function dropImage(file: File, x: number, y: number) {
    const api = controller.current;
    if (!api || active.current || !props.canEdit() || props.readOnly) return;
    if (!/^image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|jfif|svg\+xml)$/.test(file.type) || file.size > 4 * 1024 * 1024) {
      props.onNotice("Drop a supported image up to 4 MiB, or use Insert image.");
      return;
    }
    try {
      const dataURL = await getDataURL(file);
      const image = new Image();
      image.src = dataURL;
      await image.decode();
      if (api !== controller.current || active.current || !current.current.canEdit() || current.current.readOnly) return;
      const fileId = id() as BinaryFileData["id"];
      const scale = Math.min(1, 600 / Math.max(image.naturalWidth, image.naturalHeight));
      const elements = api.getSceneElements();
      const frame = topmost(elements, (element) => element.type === "frame" && x >= element.x && y >= element.y
        && x <= element.x + element.width && y <= element.y + element.height);
      const [element] = convertToExcalidrawElements([{
        type: "image", x, y, width: image.naturalWidth * scale, height: image.naturalHeight * scale,
        status: "saved", fileId,
      }]);
      api.addFiles([{ id: fileId, dataURL, mimeType: file.type as BinaryFileData["mimeType"], created: Date.now() }]);
      api.updateScene({ elements: [...elements, { ...element, frameId: frame?.id ?? null }],
        appState: { selectedElementIds: { [element.id]: true } }, captureUpdate: CaptureUpdateAction.NEVER });
    } catch {
      props.onNotice("Could not open the dropped image.");
    }
  }

  return <div className={`lean-canvas excalidraw-surface tool-${props.tool}`} ref={props.container}
    data-board-surface data-typed-selection={!!(props.selection.cards.size || props.selection.edges.size)} role="region" aria-label="Drawing canvas" aria-describedby="board-keyboard-summary"
    onDragOver={(event) => event.preventDefault()}
    onDropCapture={(event) => {
      // The SDK treats PNGs with scene metadata as imports that replace the
      // whole canvas. Insert local images without replacing task proxies.
      event.preventDefault();
      event.stopPropagation();
      const file = event.dataTransfer.files[0];
      if (!file) return;
      const { left, top } = event.currentTarget.getBoundingClientRect();
      const view = props.view.current;
      void dropImage(file, (event.clientX - left - view.x) / view.zoom, (event.clientY - top - view.y) / view.zoom);
    }}
    onContextMenuCapture={(event) => {
      if (!hit(event.clientX, event.clientY) && !props.selection.cards.size && !props.selection.edges.size) return;
      event.preventDefault();
      event.stopPropagation();
    }}
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
      aiEnabled={false} validateEmbeddable={false} onLinkOpen={(element, event) => {
        event.preventDefault();
        const api = controller.current;
        if (!api || !element.link || !isElementLink(element.link)) return;
        const id = new URL(element.link).searchParams.get("element");
        const targets = api.getSceneElements().filter((item) => item.id === id || (id && item.groupIds.includes(id)));
        if (targets.length) api.scrollToContent(targets, { animate: true });
      }}
      onLibraryChange={(items) => {
        try {
          localStorage.setItem(libraryKey, JSON.stringify(items));
        } catch {
          current.current.onNotice("The drawing library could not be saved in this profile.");
        }
      }}
      onDuplicate={(next, existing) => {
        const ids = new Set(existing.map((item) => item.id));
        return next.filter((item) => ids.has(item.id) || (!item.customData?.raqshCard && !item.customData?.raqshEdge));
      }}
      autoFocus onPointerDown={() => { pointer.current = active.current = true; }}
      onPointerUp={() => { pointer.current = false; queueSettle(); }} />
  </div>;
}
