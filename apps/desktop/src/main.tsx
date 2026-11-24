import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { AboutSettings } from "./AboutSettings";
import { Onboarding, onboardingVersion } from "./Onboarding";
import { Settings } from "./Settings";
import { usePreferences } from "./preferences";
import { brand } from "./generated/brand";
import { edition } from "./generated/edition";
import icon from "./generated/icon.svg";
import type { BoardInfo, OpenBoard, Page, Project } from "./model";
import "./generated/brand.css";
import "./style.css";
import "./preferences.css";

declare global {
  interface Window { __BOARD_FIXTURE__?: string }
}

const Editor = import.meta.env.VITE_TAURI_SHELL === "1" ? null : lazy(async () => {
  const editor = await import("./lean/LeanEditor");
  // Legacy labels become native text elements whose bounds are measured on creation.
  await document.fonts.load("17px Excalifont").catch(() => {});
  return editor;
});
type CloseEditor = (windowClose: boolean) => void;
const emptyPage = { items: [], nextOffset: null };
type Overlay = "settings" | "about" | "welcome" | "tour";

function Workspace() {
  const [projects, setProjects] = useState<Page<Project>>(emptyPage);
  const [project, setProject] = useState<Project>();
  const [boards, setBoards] = useState<Page<BoardInfo>>(emptyPage);
  const [opened, setOpened] = useState<OpenBoard>();
  const [action, setAction] = useState<{ kind: "rename" | "delete"; board: BoardInfo }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>();
  const [libraryReady, setLibraryReady] = useState(false);
  const preferences = usePreferences();
  const tourConsidered = useRef(false);
  const overlayTrigger = useRef<HTMLElement>();
  const projectFolder = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const close = useRef<CloseEditor>();
  const active = useRef(false);
  const importInput = useRef<HTMLInputElement>(null);
  const boardFocus = useRef<string>();

  async function run(task: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try { await task(); } catch (error) { setError(String(error)); }
    finally { pending.current = false; setBusy(false); }
  }

  async function loadProjects(offset = 0) {
    const page = await invoke<Page<Project>>("list_projects", { offset });
    setProjects((prior) => offset ? { ...page, items: [...prior.items, ...page.items] } : page);
  }

  async function loadBoards(owner: Project, offset = 0) {
    const page = await invoke<Page<BoardInfo>>("list_boards", { project: owner.id, offset });
    setBoards((prior) => offset ? { ...page, items: [...prior.items, ...page.items] } : page);
  }

  async function selectProject(owner: Project) {
    await loadBoards(owner);
    setAction(undefined);
    setProject(owner);
  }

  function showBoard(board: OpenBoard) {
    active.current = true;
    boardFocus.current = board.board.id;
    setOpened(board);
  }

  useEffect(() => {
    const subscription = listen("desktop-close-requested", () => {
      const finish = () => {
        if (close.current) close.current(true);
        else if (!pending.current && !active.current) void invoke("finish_close").catch((error) => setError(String(error)));
      };
      if (preferences.work.current) void preferences.work.current.then(finish);
      else finish();
    });
    if (!Editor) return () => { void subscription.then((unlisten) => unlisten()); };
    const fixture = window.__BOARD_FIXTURE__;
    void run(async () => {
      if (fixture) {
        const { openBenchmark } = await import("./benchmark");
        const board = await openBenchmark(fixture);
        const page = await invoke<Page<Project>>("list_projects", { offset: 0 });
        setProjects(page);
        const owner = page.items.find((item) => item.id === board.scope.projectId);
        if (owner) setProject(owner);
        showBoard(board);
      } else {
        await loadProjects();
        setLibraryReady(true);
      }
    });
    return () => { void subscription.then((unlisten) => unlisten()); };
  }, []);

  useEffect(() => {
    if (!libraryReady || !preferences.loaded || busy || tourConsidered.current) return;
    tourConsidered.current = true;
    if (preferences.value.onboardingVersion < onboardingVersion && !overlay && !project) {
      overlayTrigger.current = projectFolder.current ?? undefined;
      setOverlay("welcome");
    }
  }, [libraryReady, preferences.loaded, preferences.value.onboardingVersion, overlay, project, busy]);

  useLayoutEffect(() => {
    if (!overlay && overlayTrigger.current) {
      overlayTrigger.current.focus({ preventScroll: true });
      overlayTrigger.current = undefined;
    }
  }, [overlay]);

  useEffect(() => {
    if (!opened && !busy && boardFocus.current) {
      document.querySelector<HTMLButtonElement>(`[data-board-id="${boardFocus.current}"]`)?.focus();
      boardFocus.current = undefined;
    }
  }, [opened, busy]);

  function closeBoard() {
    active.current = false;
    setOpened(undefined);
    void run(async () => {
      if (project) await loadBoards(project);
      else await loadProjects();
    });
  }

  function chooseProject(relocate: boolean) {
    tourConsidered.current = true;
    void run(async () => {
      const chosen = await invoke<Project | null>("choose_project", { relocate: relocate ? project?.id : null });
      if (!chosen) return;
      await loadProjects();
      await selectProject(chosen);
    });
  }

  function openSettings(trigger: HTMLElement) {
    tourConsidered.current = true;
    overlayTrigger.current = trigger;
    setOverlay("settings");
  }

  function closeTour() {
    if (preferences.value.onboardingVersion < onboardingVersion) preferences.update({ onboardingVersion });
    setOverlay(overlay === "tour" ? "settings" : undefined);
  }

  function submitBoard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project) return;
    const form = event.currentTarget;
    const title = String(new FormData(form).get("title"));
    void run(async () => {
      if (action?.kind === "rename") {
        await invoke("rename_board", { project: project.id, board: action.board.id, title });
        setAction(undefined);
        await loadBoards(project);
      } else {
        const board = await invoke<BoardInfo>("create_board", { project: project.id, title });
        form.reset();
        showBoard(await invoke<OpenBoard>("open_board", { project: project.id, board: board.id }));
      }
    });
  }

  const dialog = overlay === "settings" ? <Settings preferences={preferences} onClose={() => setOverlay(undefined)}
    onTour={() => setOverlay("tour")} onAbout={() => setOverlay("about")} />
    : overlay === "about" ? <AboutSettings onClose={() => setOverlay(undefined)} onBack={() => setOverlay("settings")} />
    : overlay ? <Onboarding firstRun={overlay === "welcome"} onClose={closeTour} /> : null;

  if (opened && Editor) return (
    <main className="board-workspace">
      <Suspense fallback={<p role="status" className="board-loading">Opening board…</p>}>
        <Editor opened={opened} registerClose={close} onClose={closeBoard} dark={preferences.dark} onSettings={openSettings} />
      </Suspense>
      {dialog}
    </main>
  );

  return (
    <main className="workspace">
      <div className="library">
        <div className="library-sidebar">
          <header className="app-mark">
            <img src={icon} width="32" height="32" alt="" />
            <div>
              <h1>{brand.displayName}</h1>
              <p className="edition-label">{edition.label}</p>
            </div>
          </header>
          {Editor && <section aria-label="Projects">
            <div className="library-heading"><h2>Projects</h2>
              <button className="ui-button" disabled={busy} onClick={() => chooseProject(false)} title="Open folder…">
                <Icon name="add" size={16} /><span className="visually-hidden">Open folder…</span>
              </button>
            </div>
            <ul className="library-list">{projects.items.map((item) => <li key={item.id}>
              <button disabled={busy} className="project-link" aria-current={project?.id === item.id}
                onClick={() => void run(() => selectProject(item))}>
                <Icon name="folder" /><span><strong dir="auto">{item.title}</strong><small title={item.root}>{item.root}</small></span>
              </button>
            </li>)}</ul>
            {projects.nextOffset !== null && <button className="ui-button" disabled={busy} onClick={() => void run(() => loadProjects(projects.nextOffset!))}>More projects</button>}
          </section>}
          <button type="button" className="project-link settings-link" disabled={busy} onClick={(event) => openSettings(event.currentTarget)}>
            <Icon name="settings" />Settings
          </button>
        </div>
        {Editor && <div className="library-content">
        {project ? <section aria-label="Boards">
          <div className="library-heading"><h2 dir="auto">{project.title}</h2>
            <button className="ui-button" disabled={busy} onClick={() => chooseProject(true)}>Locate folder…</button>
          </div>
          <p className="library-caption">Boards</p>
          <div className="library-actions">
            <form onSubmit={submitBoard}>
              <input name="title" aria-label="New board title" placeholder="Board title" required maxLength={256} dir="auto" />
              <button className="ui-button primary" disabled={busy} type="submit"><Icon name="add" size={16} />Create board</button>
            </form>
            <button className="ui-button" disabled={busy} onClick={() => importInput.current?.click()}>Import board…</button>
            <input ref={importInput} type="file" accept=".raqsh,application/json" hidden onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!file) return;
              void run(async () => {
                if (file.size > 8 * 1024 * 1024) throw new Error("Board file exceeds the 8 MiB limit.");
                const input = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
                const imported = await invoke<BoardInfo>("import_board", { project: project.id, input });
                showBoard(await invoke<OpenBoard>("open_board", { project: project.id, board: imported.id }));
              });
            }} />
          </div>
          <ul className="library-list">{boards.items.map((board) => <li className="board-row" key={board.id}>
            <button className="board-link" data-board-id={board.id} disabled={busy} dir="auto" onClick={() => void run(async () => {
              showBoard(await invoke<OpenBoard>("open_board", { project: project.id, board: board.id }));
            })}><Icon name="board" />{board.title}</button>
            <button className="ui-button row-action" disabled={busy} onClick={() => setAction({ kind: "rename", board })}>Rename</button>
            <button className="ui-button row-action" disabled={busy} onClick={() => setAction({ kind: "delete", board })}>Delete</button>
          </li>)}</ul>
          {!boards.items.length && <p className="library-caption">Create a board to start this project’s plan.</p>}
          {boards.nextOffset !== null && <button className="ui-button" disabled={busy} onClick={() => void run(() => loadBoards(project, boards.nextOffset!))}>More boards</button>}
          {action?.kind === "rename" && <Modal title="Rename board" className="board-dialog" cancel={() => setAction(undefined)}>
            <form key={action.board.id} onSubmit={submitBoard}>
              <label>Rename board<input name="title" aria-label="Rename board title" data-initial-focus required maxLength={256} dir="auto" defaultValue={action.board.title} /></label>
              <div className="dialog-actions">
                <button type="submit" disabled={busy}>Save name</button>
                <button type="button" onClick={() => setAction(undefined)}>Cancel</button>
              </div>
              {error && <p role="alert">{error}</p>}
            </form>
          </Modal>}
          {action?.kind === "delete" && <Modal title="Delete board" className="board-dialog" cancel={() => setAction(undefined)}>
            <p>Delete “{action.board.title}” and its contents?</p>
            <div className="dialog-actions">
              <button data-initial-focus onClick={() => setAction(undefined)}>Cancel</button>
              <button className="danger" disabled={busy} onClick={() => void run(async () => {
                await invoke("delete_board", { project: project.id, board: action.board.id });
                setAction(undefined);
                await loadBoards(project);
              })}>Delete board</button>
            </div>
            {error && <p role="alert">{error}</p>}
          </Modal>}
        </section> : <div className="library-empty">
          <Icon name="board" size={42} />
          <h2>{projects.items.length ? "Choose a project" : "Open a project"}</h2>
          <p>{projects.items.length ? "Select a project to open one of its boards." : "Choose the folder or worktree where you want to plan."}</p>
          <button ref={projectFolder} className="ui-button primary" disabled={busy} onClick={() => chooseProject(false)}><Icon name="folder" />Open project folder…</button>
        </div>}
        {error && !action && <p className="library-error" role="alert">{error}</p>}
        </div>}
      </div>
      {dialog}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Workspace />);
