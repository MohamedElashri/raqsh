import { id, makeCard, type Drawing, type Edge } from "./model.ts";

export const taskTemplates = {
  bug: {
    label: "Bug fix",
    summary: "Reproduce and resolve",
    steps: [
      { title: "Reproduce the bug", description: "Record the steps, environment, and expected versus actual behavior." },
      { title: "Fix the cause", description: "Identify the cause and make a targeted change." },
      { title: "Verify the fix", description: "Rerun the reproduction steps and add a regression check." },
    ],
  },
  feature: {
    label: "Feature",
    summary: "Define and deliver",
    steps: [
      { title: "Define the outcome", description: "Describe the user need, what is in scope, and what counts as done." },
      { title: "Build the change", description: "Break the work into reviewable changes and note their dependencies." },
      { title: "Check acceptance", description: "Exercise the user flow and record the result against the acceptance criteria." },
    ],
  },
  refactor: {
    label: "Refactor",
    summary: "Change safely",
    steps: [
      { title: "Capture the baseline", description: "Record the current behavior and identify the checks that protect it." },
      { title: "Refactor in steps", description: "Restructure in small changes while preserving the agreed behavior." },
      { title: "Check for regressions", description: "Rerun the baseline checks and compare the results." },
    ],
  },
};

export type TaskTemplate = keyof typeof taskTemplates;
export type TaskStep = { title: string; description: string; status?: "todo" | "done" };
export type TaskSource = TaskTemplate | "checklist";
export const maxTaskTitleLength = 256;
export const maxTaskBriefLength = 4096;

const lineBreak = /\r\n?|\n/;
const checklistLine = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\][ \t]+(\S.*)$/;

export function shortTitle(text: string) {
  return text.trim().slice(0, maxTaskTitleLength).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
}

export function suggestTaskTitle(brief: string) {
  const firstLine = brief.trim().split(lineBreak, 1)[0];
  return shortTitle(firstLine.match(checklistLine)?.[2]
    ?? firstLine.replace(/^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?$/, "$1"));
}

export function checklistSteps(brief: string) {
  const tasks: { key: string; step: TaskStep }[] = [];
  const occurrences = new Map<string, number>();
  let fence = "";
  for (const line of brief.split(lineBreak)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = "";
      continue;
    }
    if (marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) {
      fence = marker[1];
      continue;
    }
    const match = line.match(checklistLine);
    if (!match) continue;
    const text = match[2].trim();
    const title = shortTitle(text);
    const count = (occurrences.get(text) ?? 0) + 1;
    occurrences.set(text, count);
    tasks.push({ key: `checklist-${count}:${text}`, step: {
      title, description: title === text ? "" : text, status: match[1] === " " ? "todo" : "done",
    } });
  }
  return tasks;
}

export function taskBoardDocument(title: string, brief: string, draft: readonly TaskStep[], source: TaskSource) {
  const context = {
    ...makeCard("Task brief", [40, 92], 0),
    kind: "note" as const,
    description: brief,
  };
  const steps = draft.map(({ title, description, status = "todo" }, index) => ({
    ...makeCard(title.trim(), [40 + (index % 3) * 256, 218 + Math.floor(index / 3) * 126], index + 1),
    description,
    status,
  }));
  const edges = source === "checklist" ? [] : steps.slice(1).map((step, index): Edge => ({
    id: id(), from: steps[index].id, to: step.id, kind: "dependency", revision: 0,
  }));
  const drawing: Drawing = { strokes: [], labels: [], arrows: [] };
  return JSON.stringify({
    format: "dev.local.raqsh.board", schemaVersion: 1, title: title.trim(),
    nodes: [context, ...steps], edges, drawing,
  });
}
