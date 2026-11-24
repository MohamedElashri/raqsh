import { useRef, useState } from "react";
import { Modal } from "../Modal";
import type { AgentBrief } from "./agent-brief";
import "./agent-brief.css";

export function AgentBriefDialog({ brief, close }: { brief: AgentBrief; close: () => void }) {
  const [includeContext, setIncludeContext] = useState(false);
  const [message, setMessage] = useState("");
  const [copying, setCopying] = useState(false);
  const preview = useRef<HTMLTextAreaElement>(null);
  const markdown = includeContext ? brief.withContext ?? brief.markdown : brief.markdown;

  async function copy() {
    setCopying(true);
    setMessage("");
    try {
      await navigator.clipboard.writeText(markdown);
      setMessage("Copied agent brief.");
    } catch {
      preview.current?.focus();
      preview.current?.select();
      setMessage("The preview is selected. Press Ctrl+C or Command+C to copy it.");
    } finally {
      setCopying(false);
    }
  }

  return <Modal title="Agent brief" className="agent-brief-dialog" cancel={close}>
    <h2>Agent brief</h2>
    {brief.withContext && <label className="agent-brief-context">
      <input type="checkbox" checked={includeContext} disabled={copying} onChange={(event) => {
        setIncludeContext(event.target.checked);
        setMessage("");
      }} />
      Include task brief
    </label>}
    <label className="agent-brief-preview">Markdown preview
      <textarea ref={preview} data-initial-focus dir="auto" spellCheck={false} readOnly value={markdown} />
    </label>
    <p role="status" className="agent-brief-status">{message}</p>
    <div className="dialog-actions">
      <button type="button" onClick={close}>Close</button>
      <button type="button" className="primary" disabled={copying} onClick={() => void copy()}>Copy Markdown</button>
    </div>
  </Modal>;
}
