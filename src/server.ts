// src/server.ts
import express from "express";
import rateLimit from "express-rate-limit";
import pino from "pino";
import fetch from "node-fetch";
import { randomBytes } from "crypto";
import cookieSession from "cookie-session";
import { promises as fsp } from "fs";

import { cfg } from "./config.js";
import { MockLinkedIn } from "./linkedin/mock.js";
import { RestLinkedIn, exchangeCodeForToken } from "./linkedin/rest.js";
import { aggregateToEmployees } from "./logic/aggregate.js";

// ---- TS augmentation so req.session is typed ----
declare global {
  namespace Express {
    interface Request {
      session?: Record<string, any>;
    }
  }
}

const log = pino({ level: "info" });
const app = express();

app.use(rateLimit({ windowMs: 60_000, max: 60 }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cookieSession({
    name: "sid",
    secret: process.env.SESSION_SECRET || "dev_secret",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
  })
);

// Serve local avatar files, e.g. /avatars/dan.jpg
app.use("/avatars", express.static("public/avatars", { maxAge: "7d" }));

// serve /public (for /avatars/*.jpg etc.)
app.use(express.static("public", { maxAge: "1d" }));


/* =========================
   OIDC (separate LinkedIn app)
   ========================= */
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID || "";
const OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET || "";
const OIDC_ENABLED =
  String(process.env.OIDC_ENABLED || "false").toLowerCase() === "true";
const OIDC_REDIRECT_URI =
  process.env.OIDC_REDIRECT_URI || "http://localhost:3000/oidc/callback";
const OIDC_WELL_KNOWN =
  process.env.OIDC_WELL_KNOWN ||
  "https://www.linkedin.com/oauth/.well-known/openid-configuration";

type OidcConfig = {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  issuer: string;
};
let OIDC_CONF: OidcConfig | null = null;

async function discover(): Promise<OidcConfig> {
  if (OIDC_CONF) return OIDC_CONF;
  const r = await fetch(OIDC_WELL_KNOWN);
  if (!r.ok) throw new Error(`Discovery failed: ${r.status} ${r.statusText}`);
  OIDC_CONF = (await r.json()) as OidcConfig;
  return OIDC_CONF;
}

const b64url = (b: Buffer) =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const b64urlDecode = (s: string) =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const randomStr = (len = 24) => b64url(randomBytes(len));

/* ===============
   Core aggregation
   =============== */
type Emp = { urn: string; name: string; avatar?: string | null };

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
      li.getCommenters(postUrn),
    ]);
    reactors.forEach((u) => bump(u, "reactions"));
    commenters.forEach((u) => bump(u, "comments"));
  }

  const employees = aggregateToEmployees(tallies);

  // Enrich with directory (names/avatars from employees.json)
  const directory = new Map((await readEmployees()).map((e) => [e.urn, e]));
  const enriched = employees.map((r: any) => {
    const m = directory.get(r.urn) as Emp | undefined;
    return {
      ...r,
      name: m?.name || r.name,
      avatar: m?.avatar || null,
    };
  });

  return {
    mode: cfg.mock ? "MOCK" : "LIVE",
    vanity: cfg.vanity,
    orgUrn,
    postsCount: posts.length,
    employees: enriched,
  };
}

/* ===============================
   employees.json helpers + guard
   =============================== */
async function readEmployees(): Promise<Emp[]> {
  try {
    const txt = await fsp.readFile("./employees.json", "utf8");
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? (arr as Emp[]) : [];
  } catch {
    return [];
  }
}
async function writeEmployees(arr: Emp[]) {
  const tmp = "./employees.json.tmp";
  await fsp.writeFile(tmp, JSON.stringify(arr, null, 2), "utf8");
  await fsp.rename(tmp, "./employees.json");
}
const ADMIN_KEY = process.env.ADMIN_KEY || "";
function requireKey(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const key = String(req.query.key || "");
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).send("Unauthorized. Append ?key=YOUR_ADMIN_KEY.");
  }
  next();
}

/* ======
   Routes
   ====== */
app.get("/", (_req, res) =>
  res.send(`<h3>LI Employee Interactions</h3>
<ul>
  <li><a href="/ui">Open UI</a></li>
  <li><a href="/employee-interactions">Raw JSON</a></li>
  <li><a href="/export.csv">Download CSV</a></li>
  <li><a href="/login">Login (for live API)</a></li>
  <li><a href="/login-oidc">Sign in with LinkedIn (OIDC)</a></li>
</ul>`)
);

// --- UI ---
const UI_HTML = String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Employee Interactions</title>
  <style>
    :root{--green:#0AEF84;--green-deep:#0E2F25;--forest:#123A2D;--ink:#0D1A13;--mist:#DEEDB8;--foam:#EEF3EB;}
    *{box-sizing:border-box}
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:24px;color:var(--ink);background:var(--foam)}
    header{display:flex;gap:12px;align-items:center;margin-bottom:16px;padding:14px 16px;border-radius:12px;background:var(--green-deep);color:var(--foam)}
    h2{margin:0}
    a.button{padding:8px 12px;border-radius:10px;text-decoration:none;border:1px solid transparent;background:var(--green);color:var(--ink);font-weight:600}
    a.button.secondary{background:transparent;border-color:rgba(234,250,241,.35);color:var(--foam)}
    .meta{color:var(--forest);margin:12px 2px 10px}
    table{border-collapse:collapse;width:100%;overflow:hidden;border-radius:12px}
    th,td{padding:10px 12px;border:1px solid rgba(18,58,45,.12)}
    th{text-align:left;position:sticky;top:0;z-index:1;background:var(--green-deep);color:var(--foam);letter-spacing:.3px}
    tbody tr:nth-child(even){background:#f8fcf9} tbody tr:nth-child(odd){background:#fff} tbody tr:hover{background:var(--mist)}
    code{background:rgba(14,47,37,.08);padding:2px 6px;border-radius:6px}
    .pill{margin-left:auto;background:rgba(10,239,132,.18);color:#083924;padding:6px 10px;border-radius:999px;font-weight:600;font-size:12px}
    .namecell{display:flex;align-items:center;gap:10px}
    .avatar{width:28px;height:28px;border-radius:50%;object-fit:cover;border:1px solid rgba(0,0,0,.08);background:#fff}
    .avatar--placeholder{width:28px;height:28px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:#DEEDB8;color:#0D1A13;font-weight:700;font-size:12px;border:1px solid rgba(0,0,0,.06)}
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
    <thead><tr><th>#</th><th>Name</th><th>Total</th><th>Reactions</th><th>Comments</th><th>URN</th></tr></thead>
    <tbody></tbody>
  </table>
<script>
function initials(n){
  return (n||"").trim().split(/\s+/).map(s=>s[0]||"").slice(0,2).join("").toUpperCase();
}

// turn a stored avatar value into a safe <img src>
// - local: "/avatars/jane.jpg"   -> use as-is
// - remote: "https://media.licdn.com/..." -> /avatar-proxy?u=...
function asAvatarSrc(url){
  if (!url) return "";
  try {
    if (url.startsWith("/")) return url;                         // local file
    if (/^https?:\/\//i.test(url)) return "/avatar-proxy?u="+encodeURIComponent(url); // proxied
  } catch {}
  return "";
}
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
    const src = asAvatarSrc(row.avatar);
    const imgHtml = src
      ? '<img class="avatar" src="'+src+'" referrerpolicy="no-referrer" alt="">'
      : '<span class="avatar avatar--placeholder">'+initials(row.name)+'</span>';

    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>'+(i+1)+'</td>'+
      '<td><div class="namecell">'+ imgHtml + '<span>'+row.name+'</span></div></td>'+
      '<td>'+row.total+'</td>'+
      '<td>'+row.reactions+'</td>'+
      '<td>'+row.comments+'</td>'+
      '<td><code>'+row.urn+'</code></td>';
    tbody.appendChild(tr);
  });
})();
</script>
</body>
</html>`;
app.get("/ui", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(UI_HTML);
});

// Proxy external avatar URLs through our server (avoids blockers/CORS)
app.get("/avatar-proxy", async (req, res) => {
  try {
    const u = String(req.query.u || "");
    if (!u.startsWith("http")) throw new Error("bad url");

    const r = await fetch(u);
    if (!r.ok) throw new Error(`upstream ${r.status}`);

    const ct = r.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.end(buf);
  } catch (e: any) {
    res.status(404).end();
  }
});

// --- JSON & CSV ---
app.get("/employee-interactions", async (_req, res) => {
  try {
    res.json(await fetchAggregated());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

function toCsv(
  rows: Array<{
    name: string;
    total: number;
    reactions: number;
    comments: number;
    urn: string;
    avatar?: string | null;
  }>
) {
  const hdr = ["Name", "Total", "Reactions", "Comments", "URN"];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [hdr.map(esc).join(",")];
  for (const r of rows)
    lines.push([r.name, r.total, r.reactions, r.comments, r.urn].map(esc).join(","));
  return lines.join("\n");
}
app.get("/export.csv", async (_req, res) => {
  try {
    const { employees, vanity, mode } = await fetchAggregated();
    const csv = toCsv(employees);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="employee-interactions-${vanity}-${mode}.csv"`
    );
    res.send(csv);
  } catch (e: any) {
    res.status(500).send("CSV export failed: " + e.message);
  }
});

// --- LinkedIn REST OAuth (App A: Community) ---
app.get("/login", (_req, res) => {
  if (cfg.mock)
    return res.send("MOCK mode is on. Set MOCK=false in .env to use real OAuth.");
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
    res.send(
      "✅ Auth complete. Now hit <a href='/employee-interactions'>/employee-interactions</a>."
    );
  } catch (e: any) {
    res.status(500).send(`OAuth error: ${e.message}`);
  }
});

// --- Admin mapping ---
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
        li.getCommenters(postUrn),
      ]);
      reactors
        .concat(commenters)
        .filter((u) => u?.startsWith("urn:li:person:"))
        .forEach(bump);
    }
    const known = new Set((await readEmployees()).map((e) => e.urn));
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
    const avatarRaw = String(req.body?.avatar || "").trim();
    const avatar = avatarRaw ? avatarRaw : undefined;

    if (!urn.startsWith("urn:li:person:"))
      return res
        .status(400)
        .json({ error: "Valid person URN required (urn:li:person:...). " });
    if (name.length < 2) return res.status(400).json({ error: "Name is required." });

    const rows = await readEmployees();
    const idx = rows.findIndex((e) => e.urn === urn);
    if (idx >= 0) {
      rows[idx].name = name;
      if (avatar) rows[idx].avatar = avatar;
    } else {
      rows.push({ urn, name, avatar });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    await writeEmployees(rows);

    res.json({ ok: true, saved: { urn, name, avatar: avatar || null } });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// --- Admin HTML + route ---
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
    <label>Name <input id="name" size="20" placeholder="Jane Smith" required></label>
    <label>Avatar URL <input id="avatar" size="36" placeholder="/avatars/jane.jpg or https://..."></label>
    <button type="submit">Add / Update</button>
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
      '<td><input placeholder="Full name" size="20" id="name-'+i+'"> '+
      '<input placeholder="Avatar URL (optional)" size="28" id="avatar-'+i+'"> '+
      '<button data-urn="'+u.urn+'" data-idx="'+i+'">Add</button></td>';
    tb.appendChild(tr);
  });
  tb.querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click', async (ev)=>{
      const urn = ev.target.getAttribute('data-urn');
      const idx = ev.target.getAttribute('data-idx');
      const name = q('#name-'+idx).value.trim();
      const avatar = q('#avatar-'+idx).value.trim();
      if(!name) return alert('Enter a name');
      await add(urn, name, avatar);
    });
  });
}

async function add(urn, name, avatar){
  const r = await fetch('/add-employee?key='+encodeURIComponent(key), {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ urn, name, avatar })
  });
  const j = await r.json();
  q('#msg').textContent = r.ok ? 'Saved.' : (j.error || 'Failed.');
  if(r.ok) refresh();
}

q('#addform').addEventListener('submit', async (e)=>{
  e.preventDefault();
  await add(q('#urn').value.trim(), q('#name').value.trim(), q('#avatar').value.trim());
});

refresh();
</script>
</body>
</html>`;
app.get("/admin", requireKey, (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(ADMIN_HTML);
});

// --- OIDC routes (App B: OIDC) ---
app.get("/login-oidc", async (req, res) => {
  if (!OIDC_ENABLED)
    return res.status(503).send("OIDC is disabled. Set OIDC_ENABLED=true in .env.");
  try {
    const conf = await discover();
    const state = randomStr();
    const nonce = randomStr();
    req.session = { ...(req.session || {}), oidcState: state, oidcNonce: nonce };

    const u = new URL(conf.authorization_endpoint);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("response_mode", "query");
    u.searchParams.set("client_id", OIDC_CLIENT_ID);
    u.searchParams.set("redirect_uri", OIDC_REDIRECT_URI);
    u.searchParams.set("scope", "openid profile email");
    u.searchParams.set("state", state);
    u.searchParams.set("nonce", nonce);
    u.searchParams.set("prompt", "consent");

    res.redirect(u.toString());
  } catch (e: any) {
    res.status(500).send("OIDC init error: " + e.message);
  }
});

app.get("/oidc/callback", async (req, res) => {
  if (!OIDC_ENABLED) return res.status(503).send("OIDC is disabled.");
  try {
    const conf = await discover();
    const code = String((req.query as any).code || "");
    if (!code) throw new Error("Missing code");

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: OIDC_REDIRECT_URI,
      client_id: OIDC_CLIENT_ID,
      client_secret: OIDC_CLIENT_SECRET,
    });
    const tr = await fetch(conf.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!tr.ok) throw new Error(`Token error: ${tr.status} ${await tr.text()}`);
    const tokens: any = await tr.json();

    // Prefer ID token (decode payload; for prod add signature verify)
    let user: any = null;
    if (tokens.id_token) {
      const payload = String(tokens.id_token).split(".")[1];
      if (payload) {
        try {
          const c = JSON.parse(b64urlDecode(payload));
          // name
          let nameFromToken: string | null = null;
          if (typeof c.name === "string" && c.name.trim()) {
            nameFromToken = c.name.trim();
          } else {
            const parts = [c.given_name, c.family_name].filter(Boolean).join(" ");
            nameFromToken = parts || null;
          }
          user = {
            sub: c.sub,
            name: nameFromToken,
            email: typeof c.email === "string" ? c.email : null,
            picture: typeof c.picture === "string" ? c.picture : null,
          };
        } catch {
          // ignore; try userinfo below
        }
      }
    }

    // Fallback: UserInfo
    if (!user && conf.userinfo_endpoint && tokens.access_token) {
      const ur = await fetch(conf.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (ur.ok) {
        const p: any = await ur.json();
        let nameFromUI: string | null = null;
        if (typeof p.name === "string" && p.name.trim()) {
          nameFromUI = p.name.trim();
        } else {
          const parts = [p.given_name, p.family_name].filter(Boolean).join(" ");
          nameFromUI = parts || null;
        }
        user = {
          sub: p.sub,
          name: nameFromUI,
          email: typeof p.email === "string" ? p.email : null,
          picture: typeof p.picture === "string" ? p.picture : null,
        };
      }
    }

    if (!user) throw new Error("Could not obtain user claims");

    // Store session user
    req.session = { ...(req.session || {}), user };

    // ---- Auto-upsert this member into employees.json (name + avatar) ----
    // LinkedIn OIDC 'sub' is usually a member id; sometimes a URN.
    const subStr = String(user.sub || "");
    const myUrn = subStr.startsWith("urn:")
      ? subStr
      : `urn:li:person:${subStr}`;

    try {
      const rows = await readEmployees();
      const idx = rows.findIndex((e) => e.urn === myUrn);
      if (idx >= 0) {
        if (user.name) rows[idx].name = user.name;
        if (user.picture) rows[idx].avatar = user.picture;
      } else {
        rows.push({
          urn: myUrn,
          name: user.name || "Unknown",
          avatar: user.picture || null,
        });
      }
      rows.sort((a, b) => a.name.localeCompare(b.name));
      await writeEmployees(rows);
    } catch {
      // non-fatal; continue to UI
    }
    // ---------------------------------------------------------------------

    res.redirect("/ui");
  } catch (e: any) {
    res.status(500).send("OIDC callback error: " + e.message);
  }
});

// --- OIDC debug helpers ---
app.get("/oidc/.well-known", async (_req, res) => {
  if (!OIDC_ENABLED) return res.status(503).send("OIDC disabled");
  try {
    res.json(await discover());
  } catch (e: any) {
    res.status(500).send("Discovery error: " + e.message);
  }
});
app.get("/oidc/auth-url", async (req, res) => {
  if (!OIDC_ENABLED) return res.status(503).send("OIDC disabled");
  try {
    const conf = await discover();
    const state = randomStr();
    const nonce = randomStr();
    req.session = { ...(req.session || {}), oidcState: state, oidcNonce: nonce };

    const u = new URL(conf.authorization_endpoint);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("response_mode", "query");
    u.searchParams.set("client_id", OIDC_CLIENT_ID);
    u.searchParams.set("redirect_uri", OIDC_REDIRECT_URI);
    u.searchParams.set("scope", "openid profile email");
    u.searchParams.set("state", state);
    u.searchParams.set("nonce", nonce);
    res.type("text/plain").send(u.toString());
  } catch (e: any) {
    res.status(500).send("Auth URL error: " + e.message);
  }
});

// Simple helpers to check session / logout if you want them
app.get("/me.json", (req, res) => {
  res.json({ user: req.session?.user || null });
});
app.get("/logout", (req, res) => {
  req.session = null as any;
  res.redirect("/ui");
});

// --- boot ---
app.listen(cfg.port, () =>
  log.info(
    `Server http://localhost:${cfg.port} (mode=${cfg.mock ? "MOCK" : "LIVE"}, oidc=${
      OIDC_ENABLED ? "on" : "off"
    })`
  )
);
