import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { id, type Id, type Scope } from "../model";

type Binding = { id: Id; boardId: Id | null; label: string };
type Feedback = {
  id: Id; bindingId: Id; sequence: number; text: string;
  state: "queued" | "offered" | "acknowledged" | "cancelled"; response: string | null;
};
const states: Record<Feedback["state"], string> = {
  queued: "Queued", offered: "Offered to client", acknowledged: "Acknowledged", cancelled: "Cancelled",
};

export default function AgentPanel({ scope, onClose }: { scope: Scope; onClose: () => void }) {
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [recent, setRecent] = useState<Feedback[]>([]);
  const [history, setHistory] = useState<Feedback[]>([]);
  const [selected, setSelected] = useState<Id>();
  const [setup, setSetup] = useState<Id>();
  const [format, setFormat] = useState("json");
  const [revoking, setRevoking] = useState<Id>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const nextFeedback = useRef<{ id: Id; text: string; binding: Id }>();
  const inFlight = useRef(false);
  const binding = bindings.find((item) => item.id === selected) ?? bindings[0];

  const loadBindings = async () => setBindings(await invoke<Binding[]>("list_bindings", { scope }));
  const loadFeedback = async () => setRecent(await invoke<Feedback[]>("list_feedback", { scope, before: null }));

  useEffect(() => {
    let alive = true;
    let timer = 0;
    let running = false;
    let needFeedback = false;
    let needBindings = false;

    function schedule() {
      if (!alive || timer || running || (!needFeedback && !needBindings)) return;
      timer = window.setTimeout(() => {
        timer = 0;
        running = true;
        const jobs: Promise<unknown>[] = [];
        if (needFeedback) jobs.push(invoke<Feedback[]>("list_feedback", { scope, before: null })
          .then((value) => { if (alive) setRecent(value); }));
        if (needBindings) jobs.push(invoke<Binding[]>("list_bindings", { scope })
          .then((value) => { if (alive) setBindings(value); }));
        needFeedback = false;
        needBindings = false;
        void Promise.allSettled(jobs).then((results) => {
          running = false;
          const rejected = results.find((result) => result.status === "rejected");
          if (alive && rejected?.status === "rejected") setMessage(String(rejected.reason));
          schedule();
        });
      }, 40);
    }

    const feedback = listen<Id>("board-feedback-changed", (event) => {
      if (event.payload === scope.boardId) {
        needFeedback = true;
        schedule();
      }
    });
    const clients = listen("board-bindings-changed", () => {
      needBindings = true;
      schedule();
    });
    void Promise.all([feedback, clients]).then(() => {
      needBindings = true;
      needFeedback = true;
      schedule();
    }).catch((error) => { if (alive) setMessage(String(error)); });
    return () => {
      alive = false;
      clearTimeout(timer);
      void feedback.then((stop) => stop()).catch(() => {});
      void clients.then((stop) => stop()).catch(() => {});
    };
  }, [scope]);

  function run(task: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    void task().catch((error) => setMessage(String(error))).finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
  }

  function pair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    run(async () => {
      const created = await invoke<Binding>("pair_client", {
        scope, label: String(data.get("label")).trim(), projectWide: data.has("project"),
      });
      setSelected(created.id);
      setSetup(created.id);
      form.reset();
      await loadBindings();
    });
  }

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!binding) return;
    const form = event.currentTarget;
    const text = String(new FormData(form).get("feedback")).trim();
    if (!text) return;
    if (nextFeedback.current?.text !== text || nextFeedback.current.binding !== binding.id) {
      nextFeedback.current = { id: id(), text, binding: binding.id };
    }
    const pending = nextFeedback.current;
    run(async () => {
      await invoke("queue_feedback", { scope, ...pending });
      nextFeedback.current = undefined;
      form.reset();
      await loadFeedback();
    });
  }

  const older = history.at(-1) ?? recent.at(-1);
  const items = [...recent, ...history.filter((entry) => !recent.some((latest) => latest.id === entry.id))];
  return <aside id="board-agents" className="agent-panel" aria-label="Paired agents">
    <header><h2>Paired agents</h2><button type="button" onClick={onClose}>Close</button></header>
    <form onSubmit={pair}>
      <label>Client name<input name="label" required maxLength={90} dir="auto" /></label>
      <label className="project-grant"><input type="checkbox" name="project" /> Allow access to all boards in this project</label>
      <button type="submit" disabled={busy}>Approve pairing</button>
    </form>
    {binding && <>
      <label>Client<select value={binding.id} onChange={(event) => setSelected(event.target.value)}>
        {bindings.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.boardId ? "This board" : "Project"}</option>)}
      </select></label>
      <div className="agent-actions">
        <button type="button" onClick={() => setSetup(setup === binding.id ? undefined : binding.id)}>Setup command</button>
        <button type="button" disabled={busy} onClick={() => setRevoking(binding.id)}>Revoke access</button>
      </div>
      {setup === binding.id && <>
        <label>MCP client<select value={format} onChange={(event) => setFormat(event.target.value)}>
          <option value="json">Generic MCP</option>
          <option value="codex">Codex</option>
          <option value="claude">Claude Code</option>
        </select></label>
        <input aria-label="MCP setup command" readOnly
          value={`visual-board-mcp setup --pairing ${binding.id}${format === "json" ? "" : ` --format ${format}`}`}
          onFocus={(event) => event.target.select()} />
        <small>Feedback via MCP tools. Live steering is unsupported.</small>
      </>}
      {revoking === binding.id && <div className="agent-actions" role="alert">
        <button type="button" disabled={busy} onClick={() => run(async () => {
          await invoke("revoke_client", { scope, binding: binding.id });
          setRevoking(undefined);
          setSetup(undefined);
          await Promise.all([loadBindings(), loadFeedback()]);
        })}>Revoke pairing</button>
        <button type="button" onClick={() => setRevoking(undefined)}>Keep pairing</button>
      </div>}
      <form onSubmit={send}>
        <label>Feedback to {binding.label}<textarea name="feedback" dir="auto" required maxLength={2048} /></label>
        <button type="submit" disabled={busy}>Queue feedback</button>
      </form>
    </>}
    {message && <output role="alert">{message}</output>}
    {items.length > 0 && <ol aria-label="Board feedback">
      {items.map((item) => <li key={item.id}>
        <small>{bindings.find((client) => client.id === item.bindingId)?.label ?? "Previous pairing"} · {states[item.state]}</small>
        <p dir="auto">{item.text}</p>
        {item.response && <p dir="auto"><strong>Agent response </strong>{item.response}</p>}
        {item.state === "queued" && <button type="button" disabled={busy} onClick={() => run(async () => {
          await invoke("cancel_feedback", { scope, id: item.id });
          setHistory([]);
          await loadFeedback();
        })}>Cancel feedback</button>}
      </li>)}
    </ol>}
    {older && (history.length || recent.length) % 20 === 0 && <button type="button" disabled={busy} onClick={() => run(async () => {
      const page = await invoke<Feedback[]>("list_feedback", { scope, before: older.sequence });
      if (page.length === 0) setMessage("No older feedback.");
      else setHistory((prior) => [...prior, ...page]);
    })}>Older feedback</button>}
  </aside>;
}
