import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { brand } from "./generated/brand";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { statuses, type Card } from "./model";

export const onboardingVersion = 2;

const steps = [
  {
    title: "Start with a project",
    description: <>Choose a saved project or open a folder or Git worktree. Name and create a board, or use <strong>Import board</strong> to open a shared <code>.raqsh</code> file.</>,
  },
  {
    title: "Build a plan with cards",
    description: <>Press <kbd>N</kbd> to add a card on a real board. To show what must happen first, press <kbd>C</kbd> for the dependency tool. Select the prerequisite card, then the card that depends on it.</>,
  },
  {
    title: "Review progress on the board",
    description: <>Double-click a card to edit its status, priority, or details. Use <strong>Draw</strong> or <strong>Text</strong> for notes on the canvas. Press <kbd>F1</kbd> for board shortcuts.</>,
  },
  {
    title: "Pair a coding agent",
    description: <>On your board, open <strong>Agents</strong>, choose a client, and select <strong>Approve pairing</strong>. The pairing defaults to this board. Start a new client session from the project folder.</>,
  },
  {
    title: "Send feedback and review the reply",
    description: <>Write a specific request and select <strong>Queue feedback</strong> in Agents. In your client session, ask the agent to read the board feedback. Then review its reply and any card changes.</>,
  },
];

const linkPrompts = {
  idle: "Choose Dependency or press C.",
  source: "Select Build package as the prerequisite.",
  target: "Now select Verify download.",
  linked: "Verify download depends on Build package.",
};
type Link = keyof typeof linkPrompts;
type Status = Card["status"];

function Practice({ children }: { children: ReactNode }) {
  return <section className="onboarding-example" aria-label="Practice board">
    <header className="onboarding-example-heading"><Icon name="board" /><strong>Release plan</strong><span>Practice</span></header>
    {children}
  </section>;
}

function PracticeCard({ label, status, pick, buttonRef }: {
  label: string;
  status: Status;
  pick?: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const content = <><small data-status={status}>{statuses[status]}</small><strong>{label}</strong></>;
  return pick
    ? <button type="button" className="onboarding-card" ref={buttonRef} onClick={pick}>{content}</button>
    : <div className="onboarding-card">{content}</div>;
}

export function Onboarding({ onClose, firstRun }: { onClose: () => void; firstRun: boolean }) {
  const [index, setIndex] = useState(0);
  const [taskAdded, setTaskAdded] = useState(false);
  const [link, setLink] = useState<Link>("idle");
  const [status, setStatus] = useState<Status>("todo");
  const [client, setClient] = useState("Codex");
  const [feedback, setFeedback] = useState<"ready" | "queued" | "acknowledged">("ready");
  const title = useRef<HTMLHeadingElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const dependency = useRef<HTMLButtonElement>(null);
  const prerequisite = useRef<HTMLButtonElement>(null);
  const dependent = useRef<HTMLButtonElement>(null);
  const feedbackStatus = useRef<HTMLParagraphElement>(null);
  const step = steps[index];
  const final = index === steps.length - 1;

  useLayoutEffect(() => {
    if (stage.current) stage.current.scrollTop = 0;
    title.current?.focus({ preventScroll: true });
  }, [index]);

  function practiceKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (index !== 1 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
    if (event.key.toLowerCase() === "n" && !taskAdded) {
      event.preventDefault();
      addTask();
    } else if (event.key.toLowerCase() === "c" && taskAdded && link === "idle") {
      event.preventDefault();
      setLink("source");
    }
  }

  function addTask() {
    setTaskAdded(true);
    dependency.current?.focus();
  }

  useLayoutEffect(() => {
    if (link === "source") prerequisite.current?.focus();
    if (link === "target") dependent.current?.focus();
    if (link === "linked") dependency.current?.focus();
  }, [link]);

  useLayoutEffect(() => {
    if (feedback === "acknowledged") feedbackStatus.current?.focus();
  }, [feedback]);

  return <Modal title={`${brand.displayName} quick tour`} className="onboarding-dialog" cancel={onClose}>
    <header className="onboarding-header">
      <span>{brand.displayName} quick tour</span>
      <span className="onboarding-progress">Step {index + 1} of {steps.length}</span>
      <div className="onboarding-track" aria-hidden="true">
        {steps.map(({ title }, position) => <span key={title} data-reached={position <= index} />)}
      </div>
    </header>
    <div ref={stage} className="onboarding-stage" onKeyDown={practiceKeys}>
      <div className="onboarding-copy">
        <h2 ref={title} tabIndex={-1} data-initial-focus>{step.title}</h2>
        <p>{step.description}</p>
      </div>
      {index === 0 && <div className="onboarding-project-example" aria-hidden="true">
        <div><Icon name="folder" /><span><small>Project folder</small><strong>release-worktree</strong></span></div>
        <div><Icon name="board" /><span><small>Board</small><strong>Release plan</strong></span></div>
      </div>}
      {index === 1 && <Practice>
        <div className="onboarding-canvas">
          <PracticeCard label="Build package" status="done" buttonRef={prerequisite}
            pick={link === "source" ? () => setLink("target") : undefined} />
          <span className="onboarding-connector" aria-hidden="true" data-linked={link === "linked"}><Icon name="arrow" /></span>
          {taskAdded
            ? <PracticeCard label="Verify download" status={status} buttonRef={dependent}
              pick={link === "target" ? () => setLink("linked") : undefined} />
            : <span className="onboarding-card-placeholder">Add a second card</span>}
        </div>
        <div className="onboarding-activity">
          <div className="onboarding-controls">
            <button type="button" disabled={taskAdded} onClick={addTask}><Icon name="add" size={16} />Add sample card</button>
            <button type="button" ref={dependency} aria-disabled={!taskAdded || link !== "idle"}
              onClick={() => { if (taskAdded && link === "idle") setLink("source"); }}><Icon name="connect" size={16} />Dependency</button>
          </div>
          <p role="status">{taskAdded ? linkPrompts[link] : "Add the sample card or press N to try it."}</p>
        </div>
      </Practice>}
      {index === 2 && <Practice>
        <div className="onboarding-canvas">
          <PracticeCard label="Build package" status="done" />
          <span className="onboarding-connector" aria-hidden="true" data-linked={link === "linked"}><Icon name="arrow" /></span>
          <PracticeCard label="Verify download" status={status} />
        </div>
        <div className="onboarding-activity">
          <label className="onboarding-field">Change the sample status
            <select id="onboarding-status" value={status} onChange={(event) => setStatus(event.currentTarget.value as Status)}>
              {Object.entries(statuses).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <p role="status">Verify download · {statuses[status]}</p>
        </div>
      </Practice>}
      {index === 3 && <Practice>
        <div className="onboarding-activity">
          <label className="onboarding-field">Preview client setup
            <select id="onboarding-client" value={client} onChange={(event) => setClient(event.currentTarget.value)}>
              <option>Codex</option><option>Claude Code</option><option>Other MCP client</option>
            </select>
          </label>
          <p role="status">{client === "Other MCP client"
            ? <>Use <strong>MCP configuration</strong> to add the pairing to your client, then start a new session.</>
            : <><strong>{client}</strong> can be registered from the app when its CLI is installed.</>}</p>
          <p>Access for this example is scoped to <strong>Release plan</strong>. Practice stays inside the tour.</p>
        </div>
      </Practice>}
      {index === 4 && <Practice>
        <div className="onboarding-activity">
          <p className="onboarding-message">Check the download checksum before marking verification done.</p>
          <p role="status" ref={feedbackStatus} tabIndex={-1}>{feedback === "ready" ? "Sample feedback to queue" : feedback === "queued"
            ? "Queued · Waiting for the agent to read the request"
            : "Acknowledged · The agent has read the request."}</p>
          {feedback === "acknowledged" && <p>Sample reply. “I’ll check the published checksum and report what I find.”</p>}
          {feedback !== "acknowledged" && <button type="button" onClick={() => setFeedback(feedback === "ready" ? "queued" : "acknowledged")}>
            {feedback === "ready" ? "Queue sample feedback" : "Show sample acknowledgement"}
          </button>}
        </div>
      </Practice>}
    </div>
    <footer className="onboarding-actions">
      <button type="button" className="tour-skip" onClick={onClose}>{firstRun ? "Skip tour" : "Close tour"}</button>
      <div>
        {index > 0 && <button type="button" onClick={() => setIndex(index - 1)}>Back</button>}
        <button type="button" className="primary" onClick={final ? onClose : () => setIndex(index + 1)}>
          {final ? firstRun ? "Get started" : "Finish tour" : "Next"}
        </button>
      </div>
    </footer>
  </Modal>;
}
