import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MutableRefObject } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { id, kinds, makeCard, priorities, statuses, type Card, type Change, type ExcalidrawScene, type Id,
  type OpenBoard, type Operation, type Point, type Receipt } from "../model";
import type { Board, View } from "./board";
import { Checkpoint, type SaveState } from "./checkpoint";
import { boundedOffset, duplicateSelection, geometry, movableBounds, removeSelection } from "./editing";
import EditorSurface, { blankSelection, countSelection, type BoardSelection, type Tool } from "./EditorSurface";
import { exportScene, openScene } from "./scene";
import AgentPanel from "./AgentPanel";
import { brand } from "../generated/brand";
import { Icon } from "../Icon";
import { Modal } from "../Modal";
import "../editor.css";
import "./lean.css";

type Edit = { card: Card; fresh: boolean };
type Delta = Pick<Receipt, "revision" | "changes">;
type DeltaPage = { revision: number; deltas: Delta[]; nextRevision: number };
type HistoryAction = "record" | "undo" | "redo";
type HistoryEntry = { changes: Change[]; scene?: ExcalidrawScene };
type Submission = { operation: Operation; scene?: ExcalidrawScene; history: HistoryAction; selection?: BoardSelection };
type Props = {
  opened: OpenBoard;
  registerClose: MutableRefObject<((windowClose: boolean) => void) | undefined>;
  onClose: () => void;
};

const tools: { id: Exclude<Tool, "connect" | "frame" | "laser">; label: string; key?: string; number?: string }[] = [
  { id: "pan", label: "Hand", key: "h" },
  { id: "select", label: "Selection", key: "v", number: "1" },
  { id: "rectangle", label: "Rectangle", key: "r", number: "2" },
  { id: "diamond", label: "Diamond", key: "d", number: "3" },
  { id: "ellipse", label: "Ellipse", key: "o", number: "4" },
  { id: "arrow", label: "Arrow", key: "a", number: "5" },
  { id: "line", label: "Line", key: "l", number: "6" },
  { id: "pen", label: "Draw", key: "p", number: "7" },
  { id: "text", label: "Text", key: "t", number: "8" },
  { id: "image", label: "Insert image", number: "9" },
  { id: "eraser", label: "Eraser", key: "e", number: "0" },
];
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
  const [scene, setScene] = useState(() => openScene(drawing));
  const sceneRef = useRef(scene);
  const [tool, setTool] = useState<Tool>("select");
  const [keepTool, setKeepTool] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [selection, setSelection] = useState(blankSelection);
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
  const canvas = useRef<HTMLDivElement>(null);
  const controller = useRef<ExcalidrawImperativeAPI>(null);
  const settleScene = useRef<() => void>();
  const active = useRef(false);
  const cardsLayer = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<Id, HTMLDivElement>());
  const list = useRef<HTMLOListElement>(null);
  const listToggle = useRef<HTMLButtonElement>(null);
  const agentsToggle = useRef<HTMLButtonElement>(null);
  const selectionRef = useRef(selection);
  const focusedCard = useRef<Id>();
  const view = useRef<View>({ x: 0, y: 0, zoom: 1 });
  const revision = useRef(info.semanticRevision);
  const undoHistory = useRef<HistoryEntry[]>([]);
  const redoHistory = useRef<HistoryEntry[]>([]);
  const semantic = useRef<Promise<void>>();
  const failed = useRef<Submission>();
  const dependency = useRef<Id>();
  const latestClose = useRef<(windowClose: boolean) => void>();
  const locked = useRef(false);
  const draftChanged = useRef(false);
  const editAnchor = useRef<HTMLElement>();
  const remoteTimer = useRef(0);
  const remoteNeeded = useRef(false);
  const remoteBusy = useRef(false);
  const mounted = useRef(false);
  const remoteRefresh = useRef<() => void>();
  const [saver] = useState(() => new Checkpoint(scope, info.drawingRevision, drawing, setSaveState));
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const changeTheme = (event: MediaQueryListEvent) => setDark(event.matches);
    const flushHidden = () => {
      if (document.hidden && !locked.current) void saver.flush().catch(() => {});
    };
    document.addEventListener("visibilitychange", flushHidden);
    media.addEventListener("change", changeTheme);
    registerClose.current = (windowClose) => latestClose.current?.(windowClose);
    return () => {
      registerClose.current = undefined;
      saver.dispose();
      document.removeEventListener("visibilitychange", flushHidden);
      media.removeEventListener("change", changeTheme);
    };
  }, [registerClose, saver]);

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
    if (!mounted.current || remoteTimer.current || remoteBusy.current || active.current || semantic.current
      || failed.current || locked.current || edit) return;
    remoteTimer.current = window.setTimeout(() => {
      remoteTimer.current = 0;
      remoteRefresh.current?.();
    }, 30);
  }

  remoteRefresh.current = () => {
    if (!mounted.current || !remoteNeeded.current || remoteBusy.current || active.current || semantic.current
      || failed.current || locked.current || edit) return;
    remoteNeeded.current = false;
    remoteBusy.current = true;
    void invoke<DeltaPage>("board_deltas", { scope, since: revision.current })
      .then((page) => {
        if (!mounted.current) return;
        const changes = page.deltas.filter((delta) => delta.revision > revision.current);
        if (changes.length) {
          project(changes);
          const retainDrawing = (stack: HistoryEntry[]) => stack.filter((entry) => entry.scene)
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
        if (mounted.current) update();
        if (remoteNeeded.current) scheduleRemote();
      });
  };

  useEffect(() => {
    if (!edit && remoteNeeded.current) scheduleRemote();
  }, [edit]);

  function project(deltas: Delta[]) {
    const picked = selectionRef.current;
    let pruned: BoardSelection | undefined;
    for (const delta of deltas) {
      for (const change of delta.changes) {
        switch (change.type) {
          case "setNode": {
            const index = board.nodes.findIndex((node) => node.id === change.node.id);
            const node = change.node;
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
            break;
          }
          case "setEdge": {
            const index = board.edges.findIndex((edge) => edge.id === change.edge.id);
            if (index < 0) board.edges.push(change.edge);
            else board.edges[index] = change.edge;
            break;
          }
          case "removeEdge": {
            const index = board.edges.findIndex((edge) => edge.id === change.id);
            if (index >= 0) board.edges.splice(index, 1);
            if (picked.edges.has(change.id)) {
              pruned ??= { ...picked, cards: new Set(picked.cards), edges: new Set(picked.edges) };
              pruned.edges.delete(change.id);
            }
            break;
          }
        }
      }
      revision.current = delta.revision;
    }
    if (pruned) chooseSelection(pruned);
    board.nodes.sort(ordered);
    update();
  }

  function chooseSelection(next: BoardSelection) {
    selectionRef.current = next;
    if (next.cards.size === 1) focusedCard.current = next.cards.values().next().value;
    setSelection(next);
  }

  function send(submission: Submission) {
    failed.current = undefined;
    setNotice("Saving board changes…");
    semantic.current = invoke<Receipt>("apply_operation", { scope, operation: submission.operation })
      .then((receipt) => {
        project([receipt]);
        finishEdit(submission.scene, receipt.inverse, submission.history, submission.selection);
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

  function commit(changes: Change[], nextScene?: ExcalidrawScene, history: HistoryAction = "record", selected?: BoardSelection) {
    if (!canEdit() || (!changes.length && !nextScene)) return false;
    if (changes.length > 64) {
      setNotice("This edit affects more than 64 cards or links. Select fewer objects and try again.");
      return false;
    }
    if (changes.length) {
      send({ operation: { id: id(), expectedRevision: revision.current, changes }, scene: nextScene, history, selection: selected });
    } else {
      finishEdit(nextScene, [], history, selected);
    }
    return true;
  }

  function finishEdit(nextScene: ExcalidrawScene | undefined, inverse: Change[], history: HistoryAction, selected?: BoardSelection) {
    const entry: HistoryEntry = { changes: inverse, scene: nextScene ? sceneRef.current : undefined };
    if (nextScene) {
      sceneRef.current = nextScene;
      setScene(nextScene);
      drawing.excalidraw = nextScene;
      drawing.strokes = [];
      drawing.labels = [];
      drawing.arrows = [];
      saver.changed();
    }
    if (selected) chooseSelection(selected);
    else if (nextScene) {
      const live = new Set(nextScene.elements.map(({ id }) => id));
      const picked = selectionRef.current;
      chooseSelection({ ...picked, elements: new Set([...picked.elements].filter((id) => live.has(id))) });
    }
    if (history === "undo") {
      undoHistory.current.pop();
      redoHistory.current.push(entry);
    } else {
      if (history === "redo") redoHistory.current.pop();
      else redoHistory.current = [];
      undoHistory.current.push(entry);
      if (undoHistory.current.length > 24) undoHistory.current.shift();
    }
    update();
  }

  function changeHistory(redo = false) {
    if (active.current || edit) return;
    const entry = (redo ? redoHistory : undoHistory).current.at(-1);
    if (entry) commit(entry.changes, entry.scene, redo ? "redo" : "undo");
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

  function addCard() {
    if (edit || locked.current || active.current || semantic.current || failed.current) return;
    const camera = view.current;
    const shift = 32 * (board.nodes.length % 7);
    const at: Point = [geometry((70 + shift - camera.x) / camera.zoom), geometry((90 + shift - camera.y) / camera.zoom)];
    openEdit({ card: makeCard("", at, (board.nodes.at(-1)?.order ?? -1) + 1), fresh: true });
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
    if (semantic.current || failed.current) return;
    const card: Card = {
      ...edit.card, title: text, description: String(values.get("description")),
      kind: values.get("kind") as Card["kind"], status: values.get("status") as Card["status"],
      priority: values.get("priority") as Card["priority"], width: Number(values.get("width")),
      height: Number(values.get("height")), x: Number(values.get("x")), y: Number(values.get("y")),
      parent: (values.get("parent") || null) as Card["parent"],
    };
    if (edit.fresh || card.parent !== edit.card.parent) card.order = (board.nodes.at(-1)?.order ?? -1) + 1;
    if (!commit([setNode(card)], undefined, "record", { ...blankSelection(), cards: new Set([card.id]) })) return;
    closeEdit(surface());
  }

  async function flush() {
    await semantic.current;
    if (failed.current) throw new Error("Resolve the unsaved card change before closing or exporting.");
    await saver.flush();
  }

  function leave(windowClose: boolean, discard = false) {
    if (locked.current) return;
    if (!discard && controller.current?.getAppState().editingTextElement) {
      setCloseFailure({ windowClose, message: "Finish editing the board text before closing." });
      return;
    }
    settleScene.current?.();
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
    if (locked.current || active.current) return;
    settleScene.current?.();
    locked.current = true;
    setPending(true);
    try {
      await deadline(flush(), 4_000);
      const written = format === "board"
        ? await invoke<boolean>("export_board", { scope })
        : await invoke<boolean>("export_preview", await (await exportScene(board.nodes, board.edges, sceneRef.current, format)).arrayBuffer(),
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
    const api = controller.current;
    if (!api || active.current) return;
    const { zoom, scrollX, scrollY, width, height } = api.getAppState();
    const value = Math.min(3, Math.max(0.1, zoom.value * factor)) as typeof zoom.value;
    api.updateScene({ appState: { zoom: { value },
      scrollX: scrollX + width / 2 * (1 / value - 1 / zoom.value),
      scrollY: scrollY + height / 2 * (1 / value - 1 / zoom.value) } });
  }

  function resetView() {
    const api = controller.current;
    if (api && !active.current) {
      const { zoom } = api.getAppState();
      api.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 as typeof zoom.value } } });
    }
  }

  function pickedCards() {
    return board.nodes.filter((card) => selectionRef.current.cards.has(card.id));
  }

  function reorder(card: Card, direction: number) {
    const siblings = board.nodes.filter((node) => node.parent === card.parent);
    const other = siblings[siblings.indexOf(card) + direction];
    if (other) commit([setNode({ ...card, order: other.order }), setNode({ ...other, order: card.order })]);
  }

  function editCard(card: Card) {
    if (!edit && !locked.current && !semantic.current && !failed.current && !remoteBusy.current) {
      selectCard(card);
      openEdit({ card, fresh: false });
    }
  }

  function deleteSelected() {
    if (active.current || edit) return;
    const picked = selectionRef.current;
    const { changes } = removeSelection(board, { ...picked, marks: new Set() });
    // Native Delete owns freeform deletion, including frame membership and bindings.
    if (picked.elements.size) {
      surface()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true }));
    } else commit(changes);
  }

  function duplicateSelected() {
    if (active.current || edit || !canEdit()) return;
    const picked = selectionRef.current;
    const offset = boundedOffset([24, 24], movableBounds(pickedCards(), [], new WeakMap()));
    const { changes, selected } = duplicateSelection(board, { ...picked, marks: new Set() }, offset);
    if (board.nodes.length + selected.cards.size > 2_000) {
      setNotice("This board reached its card limit.");
      return;
    }
    commit(changes, undefined, "record", { ...blankSelection(), cards: selected.cards, edges: selected.edges });
  }

  function cycleCards(direction: number) {
    if (!board.nodes.length) return;
    const index = board.nodes.findIndex((item) => item.id === focusedCard.current);
    const next = index === -1 ? (direction > 0 ? 0 : board.nodes.length - 1)
      : (index + direction + board.nodes.length) % board.nodes.length;
    selectCard(board.nodes[next], true);
  }

  function selectCard(card?: Card, reveal = false) {
    chooseSelection({ ...blankSelection(), cards: new Set(card ? [card.id] : []) });
    const api = controller.current;
    const element = card && api?.getSceneElements().find(({ customData }) => customData?.raqshCard === card.id);
    if (reveal && element) api?.scrollToContent(element, { animate: false });
  }

  function cancelEdit() {
    closeEdit(editAnchor.current);
  }

  function surface() {
    return canvas.current?.querySelector<HTMLElement>(".excalidraw");
  }

  function closeEdit(anchor?: HTMLElement | null) {
    editAnchor.current = undefined;
    draftChanged.current = false;
    setEdit(undefined);
    requestAnimationFrame(() => {
      const target = anchor?.isConnected && !anchor.matches(":disabled") ? anchor : surface();
      target?.focus({ preventScroll: true });
    });
  }

  function closePanel(id: "cards" | "agents") {
    if (id === "cards") setInspector(false);
    else setAgents(false);
    (id === "cards" ? listToggle : agentsToggle).current?.focus();
  }

  function selectTool(next: Tool) {
    setTool(next);
    surface()?.focus({ preventScroll: true });
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
    const target = event.target as HTMLElement;
    if (locked.current || target.closest("input, textarea, select, [contenteditable], .agent-panel")) return;
    const nativeState = controller.current?.getAppState();
    if (nativeState?.openPopup && canvas.current?.contains(target)) return;
    const shortcut = event.key.toLowerCase();
    const consume = () => { event.preventDefault(); event.stopPropagation(); };
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      if (shortcut === "z" || shortcut === "y" || (shortcut === "d" && selectionRef.current.cards.size)) {
        consume();
        settleScene.current?.();
        if (shortcut === "d") duplicateSelected();
        else changeHistory(shortcut === "y" || event.shiftKey);
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape") {
      if (active.current || nativeState?.contextMenu || nativeState?.openPopup || nativeState?.openDialog) return;
      consume();
      if (closeDisclosure(menu.current) || closeDisclosure(moreTools.current)) return;
      if (agents) closePanel("agents");
      else if (inspector) closePanel("cards");
      else {
        if (tool === "connect") selectTool("select");
        chooseSelection(blankSelection());
        setNotice("");
      }
      return;
    }
    if (active.current) return;
    const next = tools.find((item) => item.key === shortcut || item.number === shortcut);
    if (next && !event.shiftKey) { consume(); selectTool(next.id); }
    else if (shortcut === "insert" || shortcut === "n") { consume(); addCard(); }
    else if (shortcut === "c") { consume(); selectTool("connect"); }
    else if (shortcut === "q") { consume(); setKeepTool(!keepTool); }
    else if (shortcut === "f1") { consume(); setKeyboardHelp(true); }
    else if (shortcut === "[" || shortcut === "]") { consume(); cycleCards(shortcut === "[" ? -1 : 1); }
    else if (shortcut === "enter" && (selectionRef.current.cards.size > 0 || tool === "connect")
      && canvas.current?.contains(target)) {
      consume();
      if (tool === "connect") connect(pickedCards()[0]);
      else {
        const card = pickedCards()[0];
        if (card && countSelection(selectionRef.current) === 1) editCard(card);
      }
    } else if (["+", "=", "-"].includes(shortcut)) { consume(); zoom(shortcut === "-" ? 1 / 1.1 : 1.1); }
  }

  const count = countSelection(selection);
  const typedSelected = selection.cards.size > 0 || selection.edges.size > 0;
  const card = count === 1 ? nodeIndex.get(selection.cards.values().next().value ?? "") : undefined;
  const edge = count === 1 && selection.edges.size ? board.edges.find((edge) => selection.edges.has(edge.id)) : undefined;
  const group = card && nodeIndex.get(card.parent ?? "");
  const unavailable = pending || !canEdit();
  return (
    <div className="board-editor lean-editor" ref={panel} data-fixture={window.__BOARD_FIXTURE__}
      data-initial-elements={opened.nodes.length * 2 + opened.edges.length + (drawing.excalidraw?.elements.length ?? drawing.strokes.length)}
      data-semantic-revision={revision.current} data-renderer="excalidraw"
      onPointerDownCapture={(event) => {
        const target = event.target as Node;
        for (const disclosure of [menu.current, moreTools.current]) {
          if (disclosure?.open && !disclosure.contains(target)) disclosure.open = false;
        }
      }}
      onKeyDownCapture={onBoardKey}>
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
      <p id="board-keyboard-summary" className="visually-hidden">Press N to add a card. Arrow keys move the selection. Enter edits the selected card or text. F1 opens all shortcuts.</p>
      <div role="status" aria-atomic="true" className="visually-hidden">{card ? `Selected ${card.title}` : count ? `${count} selected` : ""}</div>
      <EditorSurface board={board} scene={scene} container={canvas} cardsLayer={cardsLayer} cards={cards} active={active}
        controller={controller} sync={settleScene} selection={selection} view={view} tool={tool} keepTool={keepTool}
        dark={dark} canEdit={canEdit} readOnly={pending || !!edit || keyboardHelp || !!closeFailure}
        onReady={() => { if (panel.current) panel.current.dataset.editorReady = "true"; }} onView={setZoomPercent} onTool={setTool} onSelection={chooseSelection} onEditCard={editCard} onConnect={(card) => {
          selectCard(card);
          connect(card);
        }} onSettle={() => { if (remoteNeeded.current) scheduleRemote(); }} onNotice={setNotice}
        onCommit={(changes, next, selected) => commit(changes, next, "record", selected)} />
      <div className="lean-cards" aria-hidden="true" ref={cardsLayer}>
        {board.nodes.map((item) => (
          <div key={item.id} dir="auto" className="lean-card" data-card-id={item.id}
            data-kind={item.kind} data-status={item.status} data-priority={item.priority} data-dropped={item.dropped}
            data-badge={item.dropped ? "Dropped" : statuses[item.status]}
            data-selected={selection.cards.has(item.id)}
            ref={(element) => { if (element) cards.current.set(item.id, element); else cards.current.delete(item.id); }}
            style={{ left: item.x, top: item.y, width: item.width, height: item.height }}>
            <span className="card-title">{item.title}</span>
          </div>
        ))}
      </div>
      {!board.nodes.length && !scene.elements.length && <div className="lean-empty">
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
          disabled={pending} aria-pressed={tool === id} aria-label={label}
          title={key ? `${label} (${key.toUpperCase()}${number ? ` or ${number}` : ""})` : label}
          onClick={() => selectTool(id)}>
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
            <button type="button" data-tool="frame" disabled={pending} aria-pressed={tool === "frame"}
              onClick={() => { closeDisclosure(moreTools.current); selectTool("frame"); }}>
              <Icon name="rectangle" size={16} />Frame
            </button>
            <button type="button" data-tool="laser" disabled={pending} aria-pressed={tool === "laser"}
              onClick={() => { closeDisclosure(moreTools.current); selectTool("laser"); }}>
              <Icon name="pen" size={16} />Laser pointer
            </button>
            <button type="button" data-drawing-properties disabled={pending} onClick={() => {
              closeDisclosure(moreTools.current);
              const api = controller.current;
              if (api) api.updateScene({ appState: { openMenu: api.getAppState().openMenu === "shape" ? null : "shape" } });
            }}><Icon name="more" size={16} />Drawing properties</button>
            <button type="button" data-drawing-library disabled={pending} onClick={() => {
              closeDisclosure(moreTools.current);
              controller.current?.toggleSidebar({ name: "default", tab: "library" });
            }}><Icon name="library" size={16} />Drawing library</button>
            <button type="button" data-mermaid disabled={pending} onClick={() => {
              closeDisclosure(moreTools.current);
              controller.current?.updateScene({ appState: { openDialog: { name: "ttd", tab: "mermaid" } } });
            }}><Icon name="connect" size={16} />Mermaid diagram</button>
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
      {!agents && (inspector || typedSelected) && <div className="lean-shelf">
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
      {typedSelected && <aside className="lean-selection" aria-label="Selection">
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
        {count > 1 && <strong>{count} objects selected</strong>}
        <div>
          <button type="button" disabled={unavailable || !selection.cards.size}
            onClick={duplicateSelected}>Duplicate</button>
          <button type="button" disabled={unavailable} onClick={deleteSelected}>Delete</button>
        </div>
      </aside>}
      </div>}
      {keyboardHelp && <Modal title="Board shortcuts" cancel={() => setKeyboardHelp(false)}>
        <h2>Board shortcuts</h2>
        <dl className="board-shortcuts">
          <dt>V / 1</dt><dd>Selection. Drag an empty area to select objects, or Shift-click to add and remove objects.</dd>
          <dt>Arrow keys</dt><dd>Move the selection. Hold Shift for larger steps.</dd>
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
          <dt>Ctrl / Cmd + Enter</dt><dd>Save the open card edit.</dd>
          <dt>Escape</dt><dd>Cancel a gesture or close the active panel.</dd>
        </dl>
        <button type="button" data-initial-focus onClick={() => setKeyboardHelp(false)}>Close shortcuts</button>
      </Modal>}
      {edit && <Modal title={edit.fresh ? "Add card" : "Edit card"} cancel={cancelEdit}>
        <h2>{edit.fresh ? "Add card" : "Edit card"}</h2>
        <form className="lean-edit" onSubmit={enterEdit} onChange={() => { draftChanged.current = true; }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing || (!event.ctrlKey && !event.metaKey)) return;
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }}>
        <label>Title
          <textarea name="title" dir="auto" data-initial-focus required
            defaultValue={edit.card.title} maxLength={512} />
        </label>
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
        <div className="dialog-actions">
          {remoteBusy.current && <span role="status">Syncing board…</span>}
          <button type="button" onClick={cancelEdit}>Cancel</button>
          <button type="submit" disabled={unavailable}>{edit.fresh ? "Create card" : "Save card"}</button>
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
