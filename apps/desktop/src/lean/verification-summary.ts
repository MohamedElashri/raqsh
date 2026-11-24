import type { Card, Id } from "../model";

export const verificationResults = {
  pending: "Pending",
  passed: "Passed",
  failed: "Failed",
};

export type VerificationDraft = {
  title: string;
  result: keyof typeof verificationResults;
  revision: string;
  reference?: string;
};

export type CardVerification = {
  id: Id;
  cardId: Id;
  recordedAt: number;
  check: VerificationDraft;
};

function markdownText(value: string) {
  return value.replace(/\s+/g, " ").trim().replace(/[\\`*_\[\]#<>~|&]/g, "\\$&");
}

export function reviewSummary(title: string, cards: readonly Card[], records: readonly CardVerification[]) {
  const active = cards.filter((card) => !card.dropped)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const byCard = new Map(active.map((card) => [card.id, card]));
  const evidence = records.filter((record) => byCard.has(record.cardId));
  const completed = active.filter((card) => card.kind === "task" && card.status === "done");
  const checked = new Set(evidence.map((record) => record.cardId));
  const unverified = completed.filter((card) => !checked.has(card.id));
  const review = evidence.filter(({ check }) => check.result === "passed" || check.result === "failed");
  const pending = evidence.filter(({ check }) => check.result === "pending");
  const lines = [`# Review · ${markdownText(title)}`, "", "## Completed tasks",
    ...completed.map((card) => `- ${markdownText(card.title)}`)];
  if (!completed.length) lines.push("No completed tasks.");

  function format(record: CardVerification) {
    const check = record.check;
    const card = byCard.get(record.cardId)!;
    const date = new Date(record.recordedAt).toISOString().slice(0, 10);
    return `- **${verificationResults[check.result]}** · ${markdownText(card.title)} — ${markdownText(check.title)}`
      + (check.revision ? ` · Revision ${markdownText(check.revision)}` : "")
      + ` · ${date} UTC · Manual`
      + (check.reference ? `\n  - Reference ${markdownText(check.reference)}` : "");
  }

  lines.push("", "## Recorded checks", ...review.map(format));
  if (!review.length) lines.push("No pass or fail results recorded.");
  lines.push("", "## Pending review", ...pending.map(format),
    ...unverified.map((card) => `- ${markdownText(card.title)} — No check recorded`));
  if (!pending.length && !unverified.length) lines.push("No pending review recorded.");
  return lines.join("\n");
}
