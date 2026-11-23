import { useLayoutEffect, useRef, useState } from "react";
import { brand } from "./generated/brand";
import { Icon } from "./Icon";
import { Modal } from "./Modal";

const steps = [
  {
    title: "Start with a project",
    description: <>Choose <strong>Open project folder</strong> and select an existing folder or Git worktree. Name your board and choose <strong>Create board</strong>.</>,
    preview: <><div><Icon name="folder" />Project folder</div><div><Icon name="board" />Planning board</div></>,
  },
  {
    title: "Turn the plan into cards",
    description: <>Press <kbd>N</kbd> to add a card. Use the toolbar to sketch or add text, and press <kbd>C</kbd> to connect two cards. Press <kbd>F1</kbd> on a board for the full shortcut list.</>,
    preview: <><div><Icon name="board" />Define the change</div><Icon name="arrow" /><div><Icon name="board" />Review the result</div></>,
  },
  {
    title: "Bring in a coding agent",
    description: <>Open <strong>Agents</strong>, choose your client and approve the pairing. Start a new session in your project, then ask the agent to read the board. Use the Agents panel to send feedback during the work.</>,
    preview: <><div><Icon name="plug" />Agents</div><div><Icon name="board" />Board access</div></>,
  },
];

export function Onboarding({ onClose, firstRun }: { onClose: () => void; firstRun: boolean }) {
  const [index, setIndex] = useState(0);
  const title = useRef<HTMLHeadingElement>(null);
  const step = steps[index];
  const final = index === steps.length - 1;

  useLayoutEffect(() => { title.current?.focus(); }, [index]);

  return <Modal title={`${brand.displayName} quick tour`} className="onboarding-dialog" cancel={onClose}>
    <header className="onboarding-header">
      <span>{brand.displayName} quick tour</span>
      <span className="onboarding-progress">{index + 1} of {steps.length}</span>
    </header>
    <div className="onboarding-track" aria-hidden="true">
      {steps.map(({ title }, position) => <span key={title} data-reached={position <= index} />)}
    </div>
    <div className="onboarding-preview" data-step={index} aria-hidden="true">{step.preview}</div>
    <div className="onboarding-copy">
      <h2 ref={title} tabIndex={-1} data-initial-focus>{step.title}</h2>
      <p>{step.description}</p>
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
