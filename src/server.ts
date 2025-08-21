import express from "express";
import rateLimit from "express-rate-limit";
import pino from "pino";
import { cfg } from "./config.js";
import { MockLinkedIn } from "./linkedin/mock.js";
import { RestLinkedIn, exchangeCodeForToken } from "./linkedin/rest.js";
import { aggregateToEmployees } from "./logic/aggregate.js";
import { promises as fsp } from "fs";
import type { Request, Response, NextFunction } from "express";


const log = pino({ level: "info" });
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));


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

// ---- employees.json read/write (atomic) ----
type Emp = { urn: string; name: string };

async function readEmployees(): Promise<Emp[]> {
  try {
    const txt = await fsp.readFile("./employees.json", "utf8");
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writeEmployees(arr: Emp[]) {
  const tmp = "./employees.json.tmp";
  await fsp.writeFile(tmp, JSON.stringify(arr, null, 2), "utf8");
  await fsp.rename(tmp, "./employees.json"); // atomic replace
}

// ---- simple auth using ?key=... ----
const ADMIN_KEY = process.env.ADMIN_KEY || "";
function requireKey(req: Request, res: Response, next: NextFunction) {
  const key = String(req.query.key || "");
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).send("Unauthorized. Append ?key=YOUR_ADMIN_KEY.");
  }
  next();
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
    :root{
      --green: #0AEF84;          /* primary accent */
      --green-deep: #0E2F25;     /* primary dark */
      --forest: #123A2D;         /* supporting */
      --ink: #0D1A13;            /* near-black text */
      --mist: #DEEDB8;           /* light accent */
      --foam: #EEF3EB;           /* very light bg */
    }
    * { box-sizing: border-box; }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
      margin: 24px;
      color: var(--ink);
      background: var(--foam);
    }
    header {
      display:flex; gap:12px; align-items:center; margin-bottom:16px;
      padding:14px 16px; border-radius:12px;
      background: var(--green-deep);
      color: var(--foam);
    }
    h2 { margin:0; letter-spacing:0.2px; }
    a.button {
      padding: 8px 12px;
      border-radius: 10px;
      text-decoration: none;
      border: 1px solid transparent;
      background: var(--green);
      color: var(--ink);
      font-weight: 600;
    }
    a.button:hover { filter: brightness(0.95); }
    a.button.secondary {
      background: transparent;
      border-color: rgba(234, 250, 241, 0.35);
      color: var(--foam);
    }
    .meta { color: var(--forest); margin: 12px 2px 10px; }

    table { border-collapse: collapse; width: 100%; overflow: hidden; border-radius: 12px; }
    th, td { padding: 10px 12px; border: 1px solid rgba(18,58,45,0.12); }
    th {
      text-align: left;
      position: sticky; top: 0; z-index: 1;
      background: var(--green-deep);
      color: var(--foam);
      letter-spacing: 0.3px;
    }
    tbody tr:nth-child(even) { background: #f8fcf9; }
    tbody tr:nth-child(odd)  { background: #ffffff; }
    tbody tr:hover { background: var(--mist); }
    code { background: rgba(14,47,37,0.08); padding:2px 6px; border-radius:6px; }
    .pill { margin-left:auto; background: rgba(10,239,132,0.18); color:#083924; padding:6px 10px; border-radius: 999px; font-weight:600; font-size:12px; }
  </style>
</head>
<body>
  <header>
    <h2>Employee Interactions</h2>
    <a class="button" href="/export.csv">Export CSV</a>
    <a class="button secondary" href="/employee-interactions" target="_blank">View JSON</a>
    <span id="modePill" class="pill"></span>
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

  document.getElementById('modePill').textContent = data.mode;
  document.getElementById('meta').textContent =
    'Vanity: ' + data.vanity + ' | Org URN: ' + data.orgUrn + ' | Posts scanned: ' + data.postsCount;

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
app.get("/unmapped-urns", requireKey, async (_req, res) => {
  try {
    const li = cfg.mock ? new MockLinkedIn() : new RestLinkedIn();
    const orgUrn = await li.getOrgUrnFromVanity(cfg.vanity);
    const posts = await li.getOrgPosts(orgUrn, 100);

    const counts = new Map<string, number>();
    const bump = (u: string) => counts.set(u, (counts.get(u) || 0) + 1);

    for (const postUrn of posts) {
      const [reactors, commenters] = await Promise.all([
        li.getReactors(postUrn),
        li.getCommenters(postUrn)
      ]);
      reactors.concat(commenters)
        .filter(u => u?.startsWith("urn:li:person:"))
        .forEach(bump);
    }

    const known = new Set((await readEmployees()).map(e => e.urn));
    const unmapped = [...counts.entries()]
      .filter(([urn]) => !known.has(urn))
      .map(([urn, interactions]) => ({ urn, interactions }))
      .sort((a, b) => b.interactions - a.interactions);

    res.json({ orgUrn, postsScanned: posts.length, count: unmapped.length, unmapped });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/add-employee", requireKey, async (req, res) => {
  try {
    const urn = String(req.body?.urn || "").trim();
    const name = String(req.body?.name || "").trim();

    if (!urn.startsWith("urn:li:person:")) {
      return res.status(400).json({ error: "Valid person URN required (urn:li:person:...)." });
    }
    if (name.length < 2) {
      return res.status(400).json({ error: "Name is required." });
    }

    const rows = await readEmployees();
    if (rows.some(e => e.urn === urn)) {
      return res.json({ ok: true, message: "Already present." });
    }

    rows.push({ urn, name });
    rows.sort((a, b) => a.name.localeCompare(b.name));
    await writeEmployees(rows);

    res.json({ ok: true, added: { urn, name } });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

const ADMIN_HTML = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Employee Mapping Admin</title>
<style>
  :root{--green:#0AEF84;--green-deep:#0E2F25;--forest:#123A2D;--ink:#0D1A13;--mist:#DEEDB8;--foam:#EEF3EB;}
  body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:24px;background:var(--foam);color:var(--ink);}
  header{display:flex;gap:12px;align-items:center;margin-bottom:16px;padding:14px 16px;border-radius:12px;background:var(--green-deep);color:var(--foam);}
  h2{margin:0}
  .button{padding:8px 12px;border-radius:10px;text-decoration:none;border:1px solid transparent;background:var(--green);color:var(--ink);font-weight:600}
  .panel{background:#fff;border:1px solid rgba(18,58,45,.12);border-radius:12px;padding:16px;margin-bottom:16px}
  table{border-collapse:collapse;width:100%}
  th,td{padding:8px 10px;border:1px solid rgba(18,58,45,.12)}
  th{background:var(--green-deep);color:var(--foam);position:sticky;top:0}
  tr:nth-child(even){background:#f8fcf9}
  input,button{padding:8px 10px;border-radius:8px;border:1px solid rgba(18,58,45,.25)}
  code{background:rgba(14,47,37,.08);padding:2px 6px;border-radius:6px}
</style>
</head>
<body>
<header>
  <h2>Employee Mapping Admin</h2>
  <a class="button" href="/ui">Back to UI</a>
</header>

<div class="panel">
  <h3 style="margin-top:0">Unmapped URNs</h3>
  <p>Members who interacted with your posts but aren’t in <code>employees.json</code>.</p>
  <div id="meta"></div>
  <table>
    <thead><tr><th>#</th><th>URN</th><th>Interactions</th><th>Add as</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
</div>

<div class="panel">
  <h3 style="margin-top:0">Manual Add</h3>
  <form id="addform">
    <label>URN <input id="urn" size="44" placeholder="urn:li:person:..." required></label>
    <label>Name <input id="name" size="28" placeholder="Jane Smith" required></label>
    <button type="submit">Add</button>
    <span id="msg" style="margin-left:8px;"></span>
  </form>
</div>

<script>
const params = new URLSearchParams(location.search);
const key = params.get('key') || '';
const q = s => document.querySelector(s);

async function refresh(){
  const r = await fetch('/unmapped-urns?key='+encodeURIComponent(key));
  if(!r.ok){ document.body.innerHTML = '<p>Unauthorized or server error.</p>'; return; }
  const data = await r.json();
  q('#meta').textContent = 'Org: ' + data.orgUrn + ' | Posts: ' + data.postsScanned + ' | Unmapped: ' + data.count;
  const tb = q('#rows'); tb.innerHTML='';
  data.unmapped.forEach((u, i)=>{
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>'+(i+1)+'</td><td><code>'+u.urn+'</code></td><td>'+u.interactions+'</td>'+
      '<td><input placeholder="Full name" size="24" id="name-'+i+'"> '+
      '<button data-urn="'+u.urn+'" data-idx="'+i+'">Add</button></td>';
    tb.appendChild(tr);
  });
  tb.querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click', async (ev)=>{
      const urn = ev.target.getAttribute('data-urn');
      const idx = ev.target.getAttribute('data-idx');
      const name = q('#name-'+idx).value.trim();
      if(!name) return alert('Enter a name');
      await add(urn, name);
    });
  });
}

async function add(urn, name){
  const r = await fetch('/add-employee?key='+encodeURIComponent(key), {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ urn, name })
  });
  const j = await r.json();
  q('#msg').textContent = r.ok ? 'Added.' : (j.error || 'Failed.');
  if(r.ok) refresh();
}

q('#addform').addEventListener('submit', async (e)=>{
  e.preventDefault();
  await add(q('#urn').value.trim(), q('#name').value.trim());
});

refresh();
</script>
</body>
</html>`;

app.get("/admin", requireKey, (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(ADMIN_HTML);
});


// boot
app.listen(cfg.port, () => log.info(`Server http://localhost:${cfg.port} (mode=${cfg.mock ? "MOCK" : "LIVE"})`));
