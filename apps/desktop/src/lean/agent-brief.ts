import { kinds, priorities, statuses, type Card, type Edge, type Id } from "../model.ts";

export type AgentBrief = { markdown: string; withContext?: string };

function heading(text: string) {
  return text.replace(/\s+/g, " ").trim().replace(/[\\`*_[\]{}<>#|~&]/g, "\\$&");
}

function quote(text: string) {
  return text.split(/\r\n?|\n/).map((line) => line ? `> ${line}` : ">").join("\n");
}

function describeStatus(card: Card) {
  return card.dropped ? `Dropped · ${statuses[card.status]}` : statuses[card.status];
}

export function createAgentBrief(
  title: string, cards: readonly Card[], edges: readonly Edge[], selected: ReadonlySet<Id>,
): AgentBrief | undefined {
  const chosen = cards.filter((card) => selected.has(card.id));
  if (!chosen.length) return;
  const byId = new Map(cards.map((card) => [card.id, card]));
  const needs = new Map<Id, Card[]>();
  for (const edge of edges) {
    if (edge.kind !== "dependency" || !selected.has(edge.to)) continue;
    const prerequisite = byId.get(edge.from);
    if (!prerequisite) continue;
    const prior = needs.get(edge.to);
    if (prior) prior.push(prerequisite);
    else needs.set(edge.to, [prerequisite]);
  }

  const head = `# Agent brief · ${heading(title)}`;
  const body = ["## Selected cards", ...chosen.map((card) => {
    const requirements = (needs.get(card.id) ?? []).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const lines = [
      `### ${heading(card.title)}`,
      `- Type: ${kinds[card.kind]}`,
      `- Status: ${describeStatus(card)}`,
      `- Priority: ${priorities[card.priority]}`,
      ...requirements.map((item) => `- Requires: ${heading(item.title)} (${describeStatus(item)})`),
    ];
    if (card.description.trim()) lines.push("", quote(card.description));
    return lines.join("\n");
  })].join("\n\n");
  const context = cards.filter((card) => card.kind === "note" && !card.dropped
    && card.title === "Task brief" && card.description.trim() && !selected.has(card.id));
  return {
    markdown: `${head}\n\n${body}\n`,
    withContext: context.length ? [head, "## Task brief", ...context.map((card) => quote(card.description)), body].join("\n\n") + "\n" : undefined,
  };
}
