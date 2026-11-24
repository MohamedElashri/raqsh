import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { AboutSettings } from "./AboutSettings";
import { Onboarding, onboardingVersion } from "./Onboarding";
import { Settings } from "./Settings";
import { TaskBoardDialog } from "./TaskBoardDialog";
import { BoardTemplateLibrary } from "./BoardTemplates";
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
type Overlay = "settings" | "about" | "welcome" | "tour" | "task" | "templates";

function Workspace() {
  const [projects, setProjects] = useState<Page<Project>>(emptyPage);
  const [project, setProject] = useState<Project>();
  const [boards, setBoards] = useState<Page<BoardInfo>>(emptyPage);
  const [opened, setOpened] = useState<{ board: OpenBoard; fitOnOpen: boolean }>();
  const [action, setAction] = useState<{ kind: "rename" | "delete"; board: BoardInfo }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>();
  const [libraryReady, setLibraryReady] = useState(false);
  const preferences = usePreferences();
  const tourConsidered = useRef(false);
  const overlayTrigger = useRef<HTMLElement>();
  const projectFolder = useRef<HTMLButtonElement>(null);
  const projectHeading = useRef<HTMLHeadingElement>(null);
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

  function showBoard(board: OpenBoard, fitOnOpen = false) {
    active.current = true;
    boardFocus.current = board.board.id;
    setOpened({ board, fitOnOpen });
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

  useLayoutEffect(() => {
    projectHeading.current?.focus();
  }, [project?.id]);

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

  function createTaskBoard(input: string) {
    if (!project) return;
    void run(async () => {
      const board = await invoke<BoardInfo>("import_board", { project: project.id, input });
      setOverlay(undefined);
      try {
        showBoard(await invoke<OpenBoard>("open_board", { project: project.id, board: board.id }), true);
      } catch (error) {
        await loadBoards(project);
        throw error;
      }
    });
  }

  function createTemplateBoard(id: string, title: string) {
    if (!project) return;
    void run(async () => {
      const board = await invoke<BoardInfo>("new_board_from_template", { project: project.id, id, title });
      setOverlay(undefined);
      try {
        showBoard(await invoke<OpenBoard>("open_board", { project: project.id, board: board.id }), true);
      } catch (error) {
        await loadBoards(project);
        throw error;
      }
    });
  }

  const dialog = overlay === "settings" ? <Settings preferences={preferences} onClose={() => setOverlay(undefined)}
    onTour={() => setOverlay("tour")} onAbout={() => setOverlay("about")} />
    : overlay === "about" ? <AboutSettings onClose={() => setOverlay(undefined)} onBack={() => setOverlay("settings")} />
    : overlay === "task" && project ? <TaskBoardDialog projectTitle={project.title} busy={busy} error={error}
      onCreate={createTaskBoard} onClose={() => { setError(""); setOverlay(undefined); }} />
    : overlay === "templates" && project ? <BoardTemplateLibrary projectTitle={project.title} creating={busy} error={error}
      onCreate={createTemplateBoard} onClose={() => { setError(""); setOverlay(undefined); }} />
    : overlay ? <Onboarding firstRun={overlay === "welcome"} onClose={closeTour} /> : null;

  if (opened && Editor) return (
    <main className="board-workspace">
      <Suspense fallback={<p role="status" className="board-loading">Opening board…</p>}>
        <Editor opened={opened.board} fitOnOpen={opened.fitOnOpen} registerClose={close} onClose={closeBoard} dark={preferences.dark}
          onSettings={openSettings} />
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
          {Editor && projects.items.length > 0 && <section aria-label="Projects">
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
          <div className="library-heading"><h2 ref={projectHeading} tabIndex={-1} dir="auto">{project.title}</h2>
            <button className="ui-button" disabled={busy} onClick={() => chooseProject(true)}>Locate folder…</button>
          </div>
          {boards.items.length > 0 && <p className="library-caption">Boards</p>}
          <div className={boards.items.length ? "library-actions" : "library-actions library-start"}>
            {!boards.items.length && <div className="library-start-copy">
              <h3>Create your first board</h3>
              <p>Sketch a plan on a blank board, turn a task checklist into cards, or start from a template.</p>
            </div>}
            <form onSubmit={submitBoard}>
              <input name="title" aria-label="New board title" placeholder="Board title" required maxLength={256} dir="auto" />
              <button className="ui-button primary" disabled={busy} type="submit"><Icon name="add" size={16} />Create board</button>
            </form>
            <button className="ui-button task-board-action" disabled={busy} onClick={(event) => {
              setError("");
              overlayTrigger.current = event.currentTarget;
              setOverlay("task");
            }}><Icon name="connect" size={16} />New from task…</button>
            <button className="ui-button" disabled={busy} onClick={(event) => {
              setError("");
              overlayTrigger.current = event.currentTarget;
              setOverlay("templates");
            }}><Icon name="board" size={16} />Templates…</button>
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
        </section> : <section className="library-start project-start" aria-labelledby="project-start-title">
          <span className="library-start-icon"><Icon name="board" size={22} /></span>
          <h2 id="project-start-title">{projects.items.length ? "Choose a project" : "Open a project"}</h2>
          <p>{projects.items.length
            ? "Select a saved project from the Projects list to see its boards."
            : "Choose a folder or Git worktree. Then create a blank board, start from a task, or use a template."}</p>
          <button ref={projectFolder} className={projects.items.length ? "ui-button" : "ui-button primary"} disabled={busy} onClick={() => chooseProject(false)}><Icon name="folder" />Open project folder…</button>
        </section>}
        {error && !action && overlay !== "task" && overlay !== "templates" && <p className="library-error" role="alert">{error}</p>}
        </div>}
      </div>
      {dialog}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Workspace />);
