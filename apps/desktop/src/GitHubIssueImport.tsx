import { invoke } from "@tauri-apps/api/core";
import { useId, useState, type KeyboardEvent } from "react";
import type { GitHubIssue } from "./github-issue";
import "./github-issue.css";

export function GitHubIssueImport({ busy, onApply }: {
  busy: boolean;
  onApply: (issue: GitHubIssue) => void;
}) {
  const inputId = useId();
  const [url, setUrl] = useState("");
  const [issue, setIssue] = useState<GitHubIssue>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadIssue() {
    if (busy || loading || !url.trim()) return;
    setIssue(undefined);
    setLoading(true);
    setError("");
    try {
      setIssue(await invoke<GitHubIssue>("load_github_issue", { url }));
    } catch (failure) {
      setError(String(failure));
    } finally {
      setLoading(false);
    }
  }

  function loadOnEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void loadIssue();
  }

  return <details className="github-issue-import" data-github-issue-import>
    <summary>Load a GitHub issue</summary>
    <label htmlFor={inputId}>GitHub issue URL</label>
    <div className="github-issue-input">
      <input id={inputId} name="github-issue-url" dir="ltr" maxLength={2048} value={url}
        readOnly={busy || loading} placeholder="https://github.com/owner/repo/issues/123"
        onKeyDown={loadOnEnter} onChange={(event) => {
          setUrl(event.target.value);
          setIssue(undefined);
          setError("");
        }} />
      <button type="button" disabled={busy || loading || !url.trim()} onClick={() => void loadIssue()}>
        {loading ? "Loading…" : "Load issue"}
      </button>
    </div>
    {loading && <p role="status">Loading the issue with GitHub CLI…</p>}
    {error && <p className="library-error" role="alert">{error}</p>}
    {issue && <div className="github-issue-result">
      <p role="status" dir="auto">{issue.title}</p>
      <button type="button" disabled={busy} onClick={(event) => {
        onApply(issue);
        event.currentTarget.closest(".task-board-dialog")
          ?.querySelector<HTMLTextAreaElement>('textarea[name="brief"]')?.focus();
        setIssue(undefined);
      }}>Use issue</button>
    </div>}
  </details>;
}
