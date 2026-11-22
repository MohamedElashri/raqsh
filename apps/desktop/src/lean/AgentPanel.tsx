import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { id, type Id, type Scope } from "../model";

type Binding = { id: Id; boardId: Id | null; label: string };
type Client = { id: string; name: string; installed: boolean; automatic: boolean; skillPath: string | null };
type Configuration = { text: string; instructions: string | null; server: string };
type Feedback = {
  id: Id; bindingId: Id; sequence: number; text: string;
  state: "queued" | "offered" | "acknowledged" | "cancelled"; response: string | null;
};
type FeedbackList = { items: Feedback[]; expanded: boolean; hasOlder: boolean };
const feedbackPageSize = 20;
const states: Record<Feedback["state"], string> = {
  queued: "Queued", offered: "Offered to client", acknowledged: "Acknowledged", cancelled: "Cancelled",
};

export default function AgentPanel({ scope, onClose }: { scope: Scope; onClose: () => void }) {
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [feedback, setFeedback] = useState<FeedbackList>({ items: [], expanded: false, hasOlder: false });
  const [selected, setSelected] = useState<Id>();
  const [config, setConfig] = useState<Configuration & { binding: Id; provider: string }>();
  const [clients, setClients] = useState<Client[]>([]);
  const [provider, setProvider] = useState<string>();
  const [revoking, setRevoking] = useState<Id>();
  const [message, setMessage] = useState("");
  const [connected, setConnected] = useState("");
  const [busy, setBusy] = useState(false);
  const nextFeedback = useRef<{ id: Id; text: string; binding: Id }>();
  const feedbackRead = useRef(0);
  const inFlight = useRef(false);
  const binding = bindings.find((item) => item.id === selected) ?? bindings[0];

  const loadBindings = async () => setBindings(await invoke<Binding[]>("list_bindings", { scope }));
  const loadFeedback = useCallback(async () => {
    const read = ++feedbackRead.current;
    const page = await invoke<Feedback[]>("list_feedback", { scope, before: null });
    if (read !== feedbackRead.current) return;
    setFeedback((current) => {
      if (!current.expanded) {
        return { items: page, expanded: false, hasOlder: page.length === feedbackPageSize };
      }
      const oldest = page.at(-1);
      if (!oldest) return current;
      // Keep loaded items that have shifted below the latest page.
      return { ...current, items: [...page, ...current.items.filter((item) => item.sequence < oldest.sequence)] };
    });
  }, [scope]);
  const selectedProvider = provider ?? clients.find((client) => client.installed)?.id ?? "generic";
  const selectedClient = clients.find((client) => client.id === selectedProvider);
  const shownConfig = config?.provider === selectedProvider && config.binding === binding?.id ? config : undefined;

  useEffect(() => {
    let alive = true;
    let timer = 0;
    let running = false;
    let needFeedback = false;
    let needBindings = false;

    void invoke<Client[]>("mcp_clients").then((value) => { if (alive) setClients(value); })
      .catch((error) => { if (alive) setMessage(String(error)); });

    function schedule() {
      if (!alive || timer || running || (!needFeedback && !needBindings)) return;
      timer = window.setTimeout(() => {
        timer = 0;
        running = true;
        const jobs: Promise<unknown>[] = [];
        if (needFeedback) jobs.push(loadFeedback());
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
      feedbackRead.current += 1;
      clearTimeout(timer);
      void feedback.then((stop) => stop()).catch(() => {});
      void clients.then((stop) => stop()).catch(() => {});
    };
  }, [scope, loadFeedback]);

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

  async function showConfig(binding: Id, client?: Client) {
    const value = await invoke<Configuration>("client_config", { scope, binding, provider: client?.id ?? null });
    setConfig({ ...value, binding, provider: client?.id ?? "generic" });
  }

  function pair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const client = clients.find((item) => item.id === data.get("provider"));
    run(async () => {
      const created = await invoke<Binding>("pair_client", {
        scope, provider: client?.id ?? null, label: String(data.get("label")).trim() || (client?.name ?? ""),
        projectWide: data.has("project"),
      });
      setSelected(created.id);
      setConfig(undefined);
      form.reset();
      await loadBindings();
      if (client?.automatic) {
        setConnected(`${client.name} registered. Open a new session to use this pairing.`);
      } else if (client) {
        await showConfig(created.id, client);
      }
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

  const { items, hasOlder } = feedback;
  const older = items.at(-1);
  return <aside id="board-agents" className="agent-panel" aria-label="Paired agents">
    <header><h2>Paired agents</h2><button type="button" onClick={onClose}>Close</button></header>
    <form onSubmit={pair}>
      <label>Client<select name="provider" value={selectedProvider} onChange={(event) => setProvider(event.target.value)}>
        {clients.map((client) => <option key={client.id} value={client.id} disabled={client.automatic && !client.installed}>
          {client.name}{!client.automatic ? " (manual setup)" : client.installed ? "" : " (not installed)"}
        </option>)}
        <option value="generic">Other MCP client</option>
      </select></label>
      <label>Pairing name<input name="label" required={selectedProvider === "generic"} maxLength={90} dir="auto"
        placeholder={selectedClient?.name ?? "Client name"} /></label>
      <label className="project-grant"><input type="checkbox" name="project" /> Allow access to all boards in this project</label>
      <button type="submit" disabled={busy}>Approve pairing</button>
    </form>
    <details className="agent-skill">
      <summary>Raqsh skill</summary>
      <p>Give a paired agent instructions for updating cards and responding to board feedback.</p>
      {selectedClient?.skillPath && <p>Install in this project at <code>{selectedClient.skillPath}</code>.</p>}
      <div className="agent-actions">
        {selectedClient?.skillPath && <button type="button" disabled={busy} onClick={() => run(async () => {
          const installed = await invoke<boolean>("install_board_skill", { scope, provider: selectedClient.id });
          setConnected(installed ? "Skill installed. Open a new client session from this project."
            : "A skill file already exists at this path and was kept.");
        })}>Install skill</button>}
        <button type="button" disabled={busy} onClick={() => run(async () => {
          if (await invoke<boolean>("save_board_skill")) setConnected("SKILL.md saved. Place it in your client’s skill folder under raqsh-board.");
        })}>Save SKILL.md</button>
      </div>
    </details>
    {binding && <>
      <label>Pairing<select name="binding" value={binding.id} onChange={(event) => setSelected(event.target.value)}>
        {bindings.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.boardId ? "This board" : "Project"}</option>)}
      </select></label>
      <div className="agent-actions">
        <button type="button" disabled={busy} onClick={() => {
          if (shownConfig) { setConfig(undefined); return; }
          run(() => showConfig(binding.id, selectedClient));
        }}>MCP configuration</button>
        <button type="button" disabled={busy} onClick={() => setRevoking(binding.id)}>Revoke access</button>
      </div>
      {shownConfig && <>
        {shownConfig.instructions && <p>{shownConfig.instructions} Keep any existing server entries.</p>}
        <textarea aria-label="MCP configuration" rows={5} spellCheck={false} readOnly value={shownConfig.text}
          onFocus={(event) => event.target.select()} />
        {shownConfig.instructions && <p>For manual cleanup, remove only <code>{shownConfig.server}</code> from the client configuration.</p>}
        <div className="agent-actions">{clients.filter((client) => client.automatic && client.installed).map((client) =>
          <button key={client.id} type="button" disabled={busy} onClick={() => run(async () => {
            await invoke("connect_client", { scope, binding: binding.id, provider: client.id });
            setConnected(`${client.name} registered. Open a new session to use this pairing.`);
          })}>Connect {client.name}</button>)}</div>
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
          setFeedback((current) => ({ ...current, items: current.items.map((entry) =>
            entry.id === item.id ? { ...entry, state: "cancelled" } : entry) }));
          await loadFeedback();
        })}>Cancel feedback</button>}
      </li>)}
    </ol>}
    {older && hasOlder && <button type="button" disabled={busy} onClick={() => run(async () => {
      setFeedback((current) => ({ ...current, expanded: true }));
      const page = await invoke<Feedback[]>("list_feedback", { scope, before: older.sequence });
      setFeedback((current) => ({
        ...current, items: [...current.items, ...page], hasOlder: page.length === feedbackPageSize,
      }));
    })}>Older feedback</button>}
  </aside>;
}
