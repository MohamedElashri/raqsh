export type GitHubIssue = { title: string; body: string | null; url: string };

export function briefWithIssueSource(brief: string, url?: string) {
  if (!url) return brief;
  const source = `Source: <${url}>`;
  return brief ? `${source}\n\n${brief}` : source;
}
