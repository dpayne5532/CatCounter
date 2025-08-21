import express from "express";
import rateLimit from "express-rate-limit";
import pino from "pino";
import { cfg } from "./config.js";
import { MockLinkedIn } from "./linkedin/mock.js";
import { RestLinkedIn, exchangeCodeForToken } from "./linkedin/rest.js";
import { aggregateToEmployees } from "./logic/aggregate.js";

const log = pino({ level: "info" });
const app = express();

app.use(rateLimit({ windowMs: 60_000, max: 60 }));

// ----- shared worker: fetch + aggregate once -----
async function fetchAggregated() {
  const li = cfg.mock ? new MockLinkedIn() : new RestLinkedIn();

  const orgUrn = await li.getOrgUrnFromVanity(cfg.vanity);
  const posts = await li.getOrgPosts(orgUrn, 100);

  const tallies = new Map<string, { reactions: number; comments: number }>();
  const bump = (urn: string, key: "reactions" | "comments") => {
    const x = tallies.get(urn) || { reactions: 0, comments: 0 };
    x[key] += 1;
    tallies.set(urn, x);
  };

  for (const postUrn of posts) {
    const [reactors, commenters] = await Promise.all([
      li.getReactors(postUrn),
      li.getCommenters(postUrn)
    ]);
    reactors.forEach(u => bump(u, "reactions"));
    commenters.forEach(u => bump(u, "comments"));
  }

  const employees = aggregateToEmployees(tallies);
  return {
    mode: cfg.mock ? "MOCK" : "LIVE",
    vanity: cfg.vanity,
    orgUrn,
    postsCount: posts.length,
    employees
  };
}

// ----- routes -----
app.get("/", (_req, res) =>
  res.send(`<h3>LI Employee Interactions</h3>
<ul>
  <li><a href="/ui">Open UI</a></li>
  <li><a href="/employee-interactions">Raw JSON</a></li>
  <li><a href="/export.csv">Download CSV</a></li>
  <li><a href="/login">Login (for live API)</a></li>
</ul>`)
);

// Simple table UI (no framework)
app.get("/ui", async (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Employee Interactions</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; }
    header { display:flex; gap:12px; align-items: center; margin-bottom: 16px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; }
    th { text-align: left; background: #f5f5f5; position: sticky; top: 0; }
    tr:nth-child(even) { background: #fafafa; }
    .meta { color: #555; margin-bottom: 8px; }
    a.button { padding: 8px 12px; border: 1px solid #ddd; background: #fff; border-radius: 6px; text-decoration: none; color: #111; }
    a.button:hover { background: #f3f3f3; }
  </style>
</head>
<body>
  <header>
    <h2 style="margin:0">Employee Interactions</h2>
    <a class="button" href="/export.csv">Export CSV</a>
    <a class="button" href="/employee-interactions" target="_blank">View JSON</a>
  </header>
  <div class="meta" id="meta"></div>
  <table id="tbl">
    <thead>
      <tr>
        <th>#</th>
        <th>Name</th>
        <th>Total</th>
        <th>Reactions</th>
        <th>Comments</th>
        <th>URN</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>
<script>
(async function(){
  const res = await fetch('/employee-interactions');
  if (!res.ok) { document.body.innerHTML = '<p>Failed to load.</p>'; return; }
  const data = await res.json();
  document.getElementById('meta').textContent =
    'Mode: ' + data.mode + ' | Vanity: ' + data.vanity + ' | Org URN: ' + data.orgUrn + ' | Posts scanned: ' + data.postsCount;

  const tbody = document.querySelector('#tbl tbody');
  tbody.innerHTML = '';
  data.employees.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>'+(i+1)+'</td>'+
      '<td>'+row.name+'</td>'+
      '<td>'+row.total+'</td>'+
      '<td>'+row.reactions+'</td>'+
      '<td>'+row.comments+'</td>'+
      '<td><code>'+row.urn+'</code></td>';
    tbody.appendChild(tr);
  });
})();
</script>
</body>
</html>`);
});

// Raw JSON
app.get("/employee-interactions", async (_req, res) => {
  try {
    const payload = await fetchAggregated();
    res.json(payload);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// CSV export (hand-rolled, no deps)
function toCsv(rows: Array<{name:string; total:number; reactions:number; comments:number; urn:string}>) {
  const hdr = ['Name','Total','Reactions','Comments','URN'];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [hdr.map(esc).join(',')];
  for (const r of rows) {
    lines.push([r.name, r.total, r.reactions, r.comments, r.urn].map(esc).join(','));
  }
  return lines.join('\n');
}

app.get("/export.csv", async (_req, res) => {
  try {
    const { employees, vanity, mode } = await fetchAggregated();
    const csv = toCsv(employees);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="employee-interactions-${vanity}-${mode}.csv"`);
    res.send(csv);
  } catch (e: any) {
    res.status(500).send("CSV export failed: " + e.message);
  }
});

// OAuth (unchanged)
app.get("/login", (_req, res) => {
  if (cfg.mock) return res.send("MOCK mode is on. Set MOCK=false in .env to use real OAuth.");
  const scope = encodeURIComponent("r_organization_social_feed r_organization_social");
  const url =
    `https://www.linkedin.com/oauth/v2/authorization` +
    `?response_type=code&client_id=${cfg.clientId}` +
    `&redirect_uri=${encodeURIComponent(cfg.redirectUri)}` +
    `&scope=${scope}` +
    `&state=xyz`;
  res.redirect(url);
});

app.get("/callback", async (req, res) => {
  if (cfg.mock) return res.send("MOCK mode. Set MOCK=false to complete OAuth.");
  try {
    const code = String((req.query as any).code || "");
    if (!code) throw new Error("No code");
    await exchangeCodeForToken(code);
    res.send("✅ Auth complete. Now hit <a href='/employee-interactions'>/employee-interactions</a>.");
  } catch (e: any) {
    res.status(500).send(`OAuth error: ${e.message}`);
  }
});


// Unmapped URNs seen in interactions (so you can tag them with names)
app.get("/unmapped-urns", async (_req, res) => {
  try {
    // Recompute raw tallies without filtering to employees.json
    const li = cfg.mock ? new MockLinkedIn() : new RestLinkedIn();
    const orgUrn = await li.getOrgUrnFromVanity(cfg.vanity);
    const posts = await li.getOrgPosts(orgUrn, 100);

    const tallies = new Map<string, number>();
    const bump = (urn: string) => tallies.set(urn, (tallies.get(urn) || 0) + 1);

    for (const postUrn of posts) {
      const [reactors, commenters] = await Promise.all([li.getReactors(postUrn), li.getCommenters(postUrn)]);
      reactors.concat(commenters).forEach(u => { if (u.startsWith("urn:li:person:")) bump(u); });
    }

    const roster = new Set(JSON.parse(require("fs").readFileSync("./employees.json","utf8")).map((e: any)=>e.urn));
    const unmapped = [...tallies.entries()]
      .filter(([urn]) => !roster.has(urn))
      .map(([urn, interactions]) => ({ urn, interactions }))
      .sort((a,b)=>b.interactions-a.interactions);

    res.json({ orgUrn, postsScanned: posts.length, count: unmapped.length, unmapped });
  } catch (e:any) {
    res.status(500).json({ error: e.message });
  }
});


// boot
app.listen(cfg.port, () => log.info(`Server http://localhost:${cfg.port} (mode=${cfg.mock ? "MOCK" : "LIVE"})`));
