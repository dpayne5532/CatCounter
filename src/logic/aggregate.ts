import { readFileSync } from "fs";

export type Row = { urn: string; name: string; reactions: number; comments: number; total: number };

export function aggregateToEmployees(
  tallies: Map<string, { reactions: number; comments: number }>
): Row[] {
  const roster = new Map<string, string>(
    JSON.parse(readFileSync("./employees.json", "utf8")).map((e: any) => [e.urn, e.name])
  );
  const rows: Row[] = [];
  for (const [urn, v] of tallies.entries()) {
    if (!roster.has(urn)) continue;
    rows.push({
      urn,
      name: roster.get(urn)!,
      reactions: v.reactions,
      comments: v.comments,
      total: v.reactions + v.comments
    });
  }
  rows.sort((a, b) => b.total - a.total);
  return rows;
}
