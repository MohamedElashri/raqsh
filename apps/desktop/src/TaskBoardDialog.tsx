import { useState, type FormEvent } from "react";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { checklistSteps, maxTaskBriefLength, maxTaskTitleLength, suggestTaskTitle, taskBoardDocument, taskTemplates,
  type TaskSource, type TaskStep, type TaskTemplate } from "./task-board";
import "./task-board.css";

export function TaskBoardDialog({ projectTitle, busy, error, onCreate, onClose }: {
  projectTitle: string;
  busy: boolean;
  error: string;
  onCreate: (input: string) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<TaskSource>("feature");
  const [brief, setBrief] = useState("");
  const [title, setTitle] = useState<string>();
  const [edits, setEdits] = useState<Record<string, Partial<Pick<TaskStep, "title" | "description">>>>({});
  const briefTooLong = brief.length > maxTaskBriefLength;
  const checklist = briefTooLong ? [] : checklistSteps(brief);
  const entries: { key: string; step: TaskStep }[] = source === "checklist" ? checklist
    : taskTemplates[source].steps.map((step, index) => ({ key: `${source}-${index}`, step }));
  const steps = entries.map(({ key, step }) => ({ key, ...step, ...edits[key] }));
  const boardTitle = title ?? suggestTaskTitle(brief);
  const missingStepTitle = steps.some((step) => !step.title.trim());
  const canCreate = !busy && !briefTooLong && steps.length > 0 && !missingStepTitle && !!boardTitle.trim();

  function editStep(key: string, field: "title" | "description", value: string) {
    setEdits((prior) => ({ ...prior, [key]: { ...prior[key], [field]: value } }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canCreate) onCreate(taskBoardDocument(boardTitle, brief, steps, source));
  }

  return <Modal title="New board from task" className="task-board-dialog" cancel={() => { if (!busy) onClose(); }}>
    <form onSubmit={submit}>
      <header className="task-board-header">
        <p className="task-board-project"><Icon name="folder" size={16} /><span dir="auto">{projectTitle}</span></p>
        <h2>New board from task</h2>
        <p>Paste an issue or spec and choose a starting plan.</p>
      </header>
      <div className="task-board-body">
        <div className="task-board-content">
          <div className="task-board-fields">
            <label>Task brief <small>Optional</small>
              <textarea name="brief" dir="auto" data-initial-focus readOnly={busy} value={brief} onChange={(event) => setBrief(event.target.value)}
                aria-invalid={briefTooLong || undefined} aria-describedby="task-brief-hint"
                placeholder="Paste a task, including its goal and any constraints." />
            </label>
            <p id="task-brief-hint" data-invalid={briefTooLong} aria-live="polite">{briefTooLong
              ? `Shorten the brief to ${maxTaskBriefLength.toLocaleString()} characters.` : "Saved in the Task brief card."}</p>
            <label>Board title
              <input name="title" dir="auto" required maxLength={maxTaskTitleLength} readOnly={busy} value={boardTitle}
                onChange={(event) => setTitle(event.target.value)} placeholder="Give the board a name" />
            </label>
            <fieldset className="task-board-templates" disabled={busy}>
              <legend>Starting plan</legend>
              <div>
                {(Object.keys(taskTemplates) as TaskTemplate[]).map((key) => (
                  <label key={key} className="task-board-template">
                    <input type="radio" name="task-template" value={key} checked={source === key} onChange={() => setSource(key)} />
                    <span><strong>{taskTemplates[key].label}</strong><small>{taskTemplates[key].summary}</small></span>
                  </label>
                ))}
                {(checklist.length > 0 || source === "checklist") && <label className="task-board-template task-board-checklist">
                  <input type="radio" name="task-template" value="checklist" checked={source === "checklist"}
                    onChange={() => setSource("checklist")} />
                  <span><strong>From checklist</strong><small>{checklist.length} {checklist.length === 1 ? "item" : "items"} in the brief</small></span>
                </label>}
              </div>
            </fieldset>
          </div>
          <section className="task-board-preview" aria-labelledby="task-board-preview-title">
            <h3 id="task-board-preview-title"><Icon name="board" size={16} />Board preview</h3>
            <div className="task-board-preview-canvas">
              <p>{steps.length ? "Open a task to edit its title or details." : "Add a Markdown checklist to the brief or choose a template."}</p>
              <div className="task-board-preview-note"><Icon name="text" size={14} />Task brief</div>
              <ol key={source} data-linked={source !== "checklist"}>{steps.map((step) => <li key={step.key}>
                <details>
                  <summary><Icon name="rectangle" size={14} /><span dir="auto">{step.title.trim() || "Untitled task"}</span>
                    {step.status === "done" && <small>Done</small>}
                  </summary>
                  <div className="task-board-step-fields">
                    <label>Task title
                      <input name="step-title" dir="auto" maxLength={maxTaskTitleLength} readOnly={busy}
                        aria-invalid={!step.title.trim() || undefined} value={step.title}
                        onChange={(event) => editStep(step.key, "title", event.target.value)} />
                    </label>
                    <label>Details
                      <textarea name="step-details" dir="auto" maxLength={maxTaskBriefLength} readOnly={busy} value={step.description}
                        onChange={(event) => editStep(step.key, "description", event.target.value)} />
                    </label>
                  </div>
                </details>
              </li>)}</ol>
            </div>
          </section>
        </div>
      </div>
      <footer className="task-board-footer">
        {error && <p className="library-error" role="alert">{error}</p>}
        {missingStepTitle && <p role="status">Give each starter task a title.</p>}
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary" type="submit" disabled={!canCreate}>
          <Icon name="add" size={16} />{busy ? "Creating board…" : "Create board"}
        </button>
      </footer>
    </form>
  </Modal>;
}
