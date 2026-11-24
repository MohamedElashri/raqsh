import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { id, kinds, type Card, type Id, type Page, type Scope } from "./model";
import "./board-templates.css";

type TemplateCard = Pick<Card, "id" | "title" | "description" | "kind" | "priority">;
type TemplateDocument = {
  format: string; version: number; title: string;
  cards: TemplateCard[];
  dependencies: { from: Id; to: Id }[];
};
type TemplateInfo = { id: Id; title: string; cardCount: number };

function useTemplateWork() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function run(task: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    try { await task(); }
    catch (error) { setMessage(String(error)); }
    finally { running.current = false; setBusy(false); }
  }
  return { busy, message, run };
}

function TemplateContents({ document }: { document: TemplateDocument }) {
  const titles = new Map(document.cards.map((card) => [card.id, card.title]));
  const count = document.cards.length;
  return <section className="template-contents" aria-label="Template contents">
    <p>{count} {count === 1 ? "card" : "cards"} · {document.dependencies.length} dependencies</p>
    <details>
      <summary>Review card text and dependencies</summary>
      {count === 0 ? <p>This template starts with an empty board.</p> : <ol>
        {document.cards.map((card) => <li key={card.id}>
          <strong dir="auto">{card.title}</strong> <small>{kinds[card.kind]}</small>
          {card.description && <p dir="auto">{card.description}</p>}
        </li>)}
      </ol>}
      {document.dependencies.length > 0 && <ul aria-label="Dependencies">
        {document.dependencies.map(({ from, to }) =>
          <li key={from + to}><span dir="auto">{titles.get(from)}</span> → <span dir="auto">{titles.get(to)}</span></li>)}
      </ul>}
    </details>
  </section>;
}

export function SaveBoardTemplate({ scope, onClose, onSaved }: {
  scope: Scope; onClose: () => void; onSaved: () => void;
}) {
  const [templateId] = useState(id);
  const [document, setDocument] = useState<TemplateDocument>();
  const [name, setName] = useState("");
  const { busy, message, run } = useTemplateWork();
  function capture() {
    void run(async () => {
      const captured = await invoke<TemplateDocument>("capture_board_template", { scope });
      setDocument(captured);
      setName(captured.title);
    });
  }
  useEffect(capture, [scope]);

  return <Modal title="Save as template" className="template-dialog" cancel={() => !busy && onClose()}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!document || !name.trim()) return;
      void run(async () => {
        await invoke("save_board_template", { id: templateId, document: { ...document, title: name } });
        onSaved();
      });
    }}>
      <h2>Save as template</h2>
      <p>Reuse the cards, groups, layout, priorities, and dependencies. New boards begin with fresh progress.</p>
      <label>Template name
        <input data-initial-focus name="templateName" value={name} maxLength={256} required dir="auto"
          readOnly={busy || !document} onChange={(event) => setName(event.target.value)} />
      </label>
      {document ? <TemplateContents document={document} /> : busy ? <p role="status">Loading template preview…</p> : null}
      {message && <p role="alert">{message}</p>}
      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        {message && !document && <button type="button" disabled={busy} onClick={capture}>Retry preview</button>}
        <button type="submit" disabled={busy || !document || !name.trim()}>{busy && document ? "Saving…" : "Save template"}</button>
      </div>
    </form>
  </Modal>;
}

type Choice = { id: Id; document: TemplateDocument; saved: boolean };

export function BoardTemplateLibrary({ projectTitle, creating, error, onCreate, onClose }: {
  projectTitle: string; creating: boolean; error: string;
  onCreate: (template: Id, title: string) => void; onClose: () => void;
}) {
  const { busy: working, message, run } = useTemplateWork();
  const [page, setPage] = useState<Page<TemplateInfo>>({ items: [], nextOffset: null });
  const [choice, setChoice] = useState<Choice>();
  const [name, setName] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = working || creating;

  async function load(offset = 0) {
    const next = await invoke<Page<TemplateInfo>>("list_board_templates", { offset });
    setPage((previous) => offset ? { ...next, items: [...previous.items, ...next.items] } : next);
  }

  function select(next: Choice) {
    setChoice(next);
    setName(next.document.title);
  }

  useEffect(() => { void run(() => load()); }, []);

  return <Modal title="Board templates" className="template-dialog" cancel={() => !busy && onClose()}>
    <h2>Board templates</h2>
    <p>Start a new board in <strong dir="auto">{projectTitle}</strong>.</p>
    <div className="template-toolbar">
      <button data-initial-focus type="button" disabled={busy} onClick={() => fileInput.current?.click()}>Import template file…</button>
      <input ref={fileInput} type="file" accept=".raqsh-template,application/json" hidden onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!file) return;
        void run(async () => {
          if (file.size > 8 * 1024 * 1024) throw new Error("Template file exceeds the 8 MiB limit.");
          const input = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
          const document = await invoke<TemplateDocument>("decode_board_template", { input });
          select({ id: id(), document, saved: false });
        });
      }} />
    </div>
    {page.items.length ? <ul className="template-list" aria-label="Saved templates">
      {page.items.map((template) => <li key={template.id}>
        <button type="button" disabled={busy} aria-pressed={choice?.id === template.id} onClick={() => void run(async () => {
          const document = await invoke<TemplateDocument>("read_board_template", { id: template.id });
          select({ id: template.id, document, saved: true });
        })}><strong dir="auto">{template.title}</strong><small>{template.cardCount} {template.cardCount === 1 ? "card" : "cards"}</small></button>
      </li>)}
    </ul> : !working && !message && <p className="library-caption">Save a board as a template or import a template file.</p>}
    {page.nextOffset !== null && <button type="button" disabled={busy} onClick={() => void run(() => load(page.nextOffset!))}>More templates</button>}
    {choice && <form className="template-creation" onSubmit={(event) => {
      event.preventDefault();
      if (busy || !name.trim()) return;
      if (choice.saved) {
        onCreate(choice.id, name);
      } else {
        const document = { ...choice.document, title: name };
        void run(async () => {
          await invoke("save_board_template", { id: choice.id, document });
          select({ ...choice, document, saved: true });
          await load();
        });
      }
    }}>
      <label>{choice.saved ? "New board title" : "Template name"}
        <input name={choice.saved ? "boardTitle" : "templateName"} value={name} maxLength={256} required dir="auto"
          disabled={busy} onChange={(event) => setName(event.target.value)} />
      </label>
      <TemplateContents document={choice.document} />
      <div className="dialog-actions">
        {choice.saved && <button type="button" disabled={busy}
          onClick={() => void run(async () => { await invoke("export_board_template", { id: choice.id }); })}>Export template…</button>}
        <button type="submit" disabled={busy || !name.trim()}>
          {choice.saved ? (creating ? "Creating…" : "Create board") : "Save template"}
        </button>
      </div>
    </form>}
    {(message || error) && <p role="alert">{message || error}</p>}
    <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Close</button></div>
  </Modal>;
}
