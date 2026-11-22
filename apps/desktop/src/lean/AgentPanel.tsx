import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { id, type Id, type Scope } from "../model";

type Binding = { id: Id; boardId: Id | null; label: string };
type Provider = "codex" | "claude";
const providerNames: Record<Provider, string> = { codex: "Codex", claude: "Claude Code" };
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
  const [config, setConfig] = useState<{ binding: Id; text: string }>();
  const [clients, setClients] = useState<Provider[]>([]);
  const [provider, setProvider] = useState<Provider | "generic">();
  const [revoking, setRevoking] = useState<Id>();
  const [message, setMessage] = useState("");
  const [connected, setConnected] = useState("");
  const [busy, setBusy] = useState(false);
  const nextFeedback = useRef<{ id: Id; text: string; binding: Id }>();
  const inFlight = useRef(false);
  const binding = bindings.find((item) => item.id === selected) ?? bindings[0];

  const loadBindings = async () => setBindings(await invoke<Binding[]>("list_bindings", { scope }));
  const loadFeedback = async () => setRecent(await invoke<Feedback[]>("list_feedback", { scope, before: null }));
  const selectedProvider = provider ?? clients[0] ?? "generic";

  useEffect(() => {
    let alive = true;
    let timer = 0;
    let running = false;
    let needFeedback = false;
    let needBindings = false;

    void invoke<Provider[]>("mcp_clients").then((value) => { if (alive) setClients(value); })
      .catch((error) => { if (alive) setMessage(String(error)); });

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
    setConnected("");
    void task().catch((error) => setMessage(String(error))).finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
  }

  function pair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const client = data.get("provider");
    const provider = client === "codex" || client === "claude" ? client : null;
    run(async () => {
      const created = await invoke<Binding>("pair_client", {
        scope, provider, label: String(data.get("label")).trim() || (provider ? providerNames[provider] : ""),
        projectWide: data.has("project"),
      });
      setSelected(created.id);
      setConfig(undefined);
      form.reset();
      await loadBindings();
      if (provider) setConnected(`${providerNames[provider]} connected. Open a new session to use this pairing.`);
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
      <label>Client<select name="provider" value={selectedProvider}
        onChange={(event) => setProvider(event.target.value as Provider | "generic")}>
        {(Object.keys(providerNames) as Provider[]).map((item) => <option key={item} value={item} disabled={!clients.includes(item)}>
          {providerNames[item]}{clients.includes(item) ? "" : " (not installed)"}
        </option>)}
        <option value="generic">Other MCP client</option>
      </select></label>
      <label>Pairing name<input name="label" required={selectedProvider === "generic"} maxLength={90} dir="auto"
        placeholder={selectedProvider === "generic" ? "Client name" : providerNames[selectedProvider]} /></label>
      <label className="project-grant"><input type="checkbox" name="project" /> Allow access to all boards in this project</label>
      <button type="submit" disabled={busy}>Approve pairing</button>
    </form>
    {binding && <>
      <label>Pairing<select name="binding" value={binding.id} onChange={(event) => setSelected(event.target.value)}>
        {bindings.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.boardId ? "This board" : "Project"}</option>)}
      </select></label>
      <div className="agent-actions">
        <button type="button" disabled={busy} onClick={() => {
          if (config?.binding === binding.id) { setConfig(undefined); return; }
          run(async () => setConfig({ binding: binding.id, text: await invoke<string>("client_config", { scope, binding: binding.id }) }));
        }}>MCP configuration</button>
        <button type="button" disabled={busy} onClick={() => setRevoking(binding.id)}>Revoke access</button>
      </div>
      {config?.binding === binding.id && <>
        <textarea aria-label="MCP configuration" rows={5} spellCheck={false} readOnly value={config.text}
          onFocus={(event) => event.target.select()} />
        <div className="agent-actions">{clients.map((item) => <button key={item} type="button" disabled={busy} onClick={() => run(async () => {
          await invoke("connect_client", { scope, binding: binding.id, provider: item });
          setConnected(`${providerNames[item]} connected. Open a new session to use this pairing.`);
        })}>Connect {providerNames[item]}</button>)}</div>
      </>}
      {revoking === binding.id && <div className="agent-actions" role="alert">
        <button type="button" disabled={busy} onClick={() => run(async () => {
          try { await invoke("revoke_client", { scope, binding: binding.id }); }
          finally {
            setRevoking(undefined);
            setConfig(undefined);
            await Promise.all([loadBindings(), loadFeedback()]);
          }
        })}>Revoke pairing</button>
        <button type="button" onClick={() => setRevoking(undefined)}>Keep pairing</button>
      </div>}
      <form onSubmit={send}>
        <label>Feedback to {binding.label}<textarea name="feedback" dir="auto" required maxLength={2048} /></label>
        <button type="submit" disabled={busy}>Queue feedback</button>
      </form>
    </>}
    {message && <output role="alert">{message}</output>}
    {connected && <output role="status">{connected}</output>}
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
