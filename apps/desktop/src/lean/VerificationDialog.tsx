import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Modal } from "../Modal";
import { id, type Card, type Scope } from "../model";
import { reviewSummary, verificationResults, type CardVerification, type VerificationDraft } from "./verification-summary";
import "./verification.css";

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default function VerificationDialog({ scope, card, cards, boardTitle, onClose }: {
  scope: Scope;
  card?: Card;
  cards: readonly Card[];
  boardTitle: string;
  onClose: () => void;
}) {
  const [records, setRecords] = useState<CardVerification[]>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<VerificationDraft["result"]>("pending");
  const draftId = useRef<{ id: string; payload: string }>();
  const preview = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const dialogTitle = card ? "Card verification" : "Review summary";

  useEffect(() => {
    let current = true;
    invoke<CardVerification[]>("list_verification", { scope })
      .then((found) => { if (current) setRecords(found); })
      .catch((error) => { if (current) setError(message(error)); });
    return () => { current = false; };
  }, [scope, reload]);

  async function perform(action: () => Promise<void>) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (error) {
      setError(message(error));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!card || submitting.current) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const check: VerificationDraft = {
      title: String(fields.get("title")).trim(),
      result,
      revision: String(fields.get("revision")).trim(),
      reference: String(fields.get("reference")).trim() || undefined,
    };
    const payload = JSON.stringify(check);
    const key = draftId.current?.payload === payload ? draftId.current.id : id();
    draftId.current = { id: key, payload };
    void perform(async () => {
      const record = await invoke<CardVerification>("save_verification", { scope, card: card.id, id: key, check });
      setRecords((prior) => [record, ...(prior ?? []).filter((item) => item.id !== record.id)]);
      setResult("pending");
      form.reset();
      draftId.current = undefined;
      setNotice("Check saved.");
    });
  }

  function remove(record: CardVerification) {
    void perform(async () => {
      await invoke("remove_verification", { scope, card: record.cardId, id: record.id });
      setRecords((prior) => prior?.filter((item) => item.id !== record.id));
      setNotice("Check removed.");
    });
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Review summary copied.");
    } catch {
      preview.current?.focus();
      preview.current?.select();
      setNotice("Summary selected. Use Ctrl+C or Cmd+C to copy.");
    }
  }

  const cardRecords = card ? records?.filter((record) => record.cardId === card.id) : undefined;
  const summary = !card && records ? reviewSummary(boardTitle, cards, records) : "";

  return <Modal title={dialogTitle} className="verification-dialog" cancel={() => { if (!submitting.current) onClose(); }}>
    <h2 tabIndex={-1} data-initial-focus>{dialogTitle}</h2>
    {card && <p dir="auto" className="verification-subtitle">{card.title}</p>}
    {error && <p role="alert">{error}</p>}
    {!records && (error
      ? <button type="button" onClick={() => { setError(""); setReload((attempt) => attempt + 1); }}>Retry</button>
      : <p role="status">Loading verification…</p>)}
    {card && cardRecords && <>
      {cardRecords.length > 0 && <ul className="verification-list">{cardRecords.map((record) =>
        <li key={record.id}>
          <strong dir="auto">{record.check.title}</strong>
          <span>{verificationResults[record.check.result]} · Manual · <time dateTime={new Date(record.recordedAt).toISOString()}>
            {new Date(record.recordedAt).toLocaleDateString()}</time>
            {record.check.revision && <> · <span dir="auto">Revision {record.check.revision}</span></>}</span>
          {record.check.reference && <span dir="auto" className="verification-reference">{record.check.reference}</span>}
          <div>
            {record.check.reference && <button type="button" disabled={busy} onClick={() => void perform(() =>
              invoke("open_verification_reference", { scope, id: record.id }))}>Open reference</button>}
            <button type="button" disabled={busy} onClick={() => remove(record)}>Remove check</button>
          </div>
        </li>
      )}</ul>}
      <form className="lean-edit" onSubmit={save}>
        <label>Check<input name="title" dir="auto" required readOnly={busy} maxLength={512} placeholder="Fresh Linux install" /></label>
        <div className="edit-fields">
          <label>Result<select value={result} disabled={busy} onChange={(event) => setResult(event.currentTarget.value as VerificationDraft["result"])}>
            {Object.entries(verificationResults).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label>Revision<input name="revision" dir="auto" readOnly={busy} maxLength={256} required={result !== "pending"} placeholder="Commit or tag" /></label>
        </div>
        <label>Reference URL<input name="reference" type="url" readOnly={busy} maxLength={2048} placeholder="https://…" /></label>
        <div className="dialog-actions"><button type="submit" disabled={busy}>Record check</button></div>
      </form>
    </>}
    {summary && <textarea className="verification-preview" ref={preview} aria-label="Markdown review summary"
      dir="auto" rows={14} readOnly value={summary} />}
    {notice && <p role="status">{notice}</p>}
    <div className="dialog-actions">
      <button type="button" disabled={busy} onClick={onClose}>Close</button>
      {summary && <button type="button" onClick={() => void copy(summary)}>Copy Markdown</button>}
    </div>
  </Modal>;
}
