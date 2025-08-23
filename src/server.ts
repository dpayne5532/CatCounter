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
import { RestLinkedIn, exchangeCodeForToken, httpGet } from "./linkedin/rest.js";
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

// ====== Middleware ======
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

// ====== Helpers ======
const b64url = (b: Buffer) =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const b64urlDecode = (s: string) =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const randomStr = (len = 24) => b64url(randomBytes(len));

type Emp = { urn: string; name: string; avatar?: string | null };

// employees.json helpers
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

// guard for admin endpoints
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

// ====== Core aggregation with debug logs ======
async function fetchAggregated() {
  const li = cfg.mock ? new MockLinkedIn() : new RestLinkedIn();
  const orgUrn = await li.getOrgUrnFromVanity(cfg.vanity);
  log.info({ orgUrn }, "Resolved org URN");

  const posts = await li.getOrgPosts(orgUrn, 10);
  log.info({ count: posts.length }, "Fetched org posts");

  const tallies = new Map<string, { reactions: number; comments: number }>();
  const bump = (urn: string, key: "reactions" | "comments") => {
    const x = tallies.get(urn) || { reactions: 0, comments: 0 };
    x[key] += 1;
    tallies.set(urn, x);
  };

  for (const postUrn of posts) {
    try {
      log.info({ postUrn }, "Fetching engagement for post");
      const [reactors, commenters] = await Promise.all([
        li.getReactors(postUrn),
        li.getCommenters(postUrn),
      ]);
      log.info({ postUrn, reactors, commenters }, "Engagement results");

      reactors.forEach((u) => bump(u, "reactions"));
      commenters.forEach((u) => bump(u, "comments"));
    } catch (err: any) {
      log.error({ postUrn, err }, "Error fetching engagement");
    }
  }

  const employees = aggregateToEmployees(tallies);
  log.info({ employeesCount: employees.length }, "Aggregated employees");

  const directory = new Map((await readEmployees()).map((e) => [e.urn, e]));
  const enriched = employees.map((r: any) => {
    const m = directory.get(r.urn) as Emp | undefined;
    return {
      ...r,
      name: m?.name || r.urn,   // fallback: show URN as name
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

// ====== Routes ======
app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<h1>Catalyst Count</h1><p><a href="/ui">Go to Dashboard</a></p>`);
});

app.get("/ui", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<h2>Dashboard</h2><p>Go to <a href="/employee-interactions">/employee-interactions</a></p>`);
});

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
  } catch {
    res.status(404).end();
  }
});

app.get("/employee-interactions", async (_req, res) => {
  try {
    res.json(await fetchAggregated());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/export.csv", async (_req, res) => {
  try {
    const { employees, vanity, mode } = await fetchAggregated();
    const hdr = ["Name", "Total", "Reactions", "Comments", "URN"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [hdr.map(esc).join(",")];
    for (const r of employees) {
      lines.push([r.name, r.total, r.reactions, r.comments, r.urn].map(esc).join(","));
    }
    const csv = lines.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="employee-interactions-${vanity}-${mode}.csv"`);
    res.send(csv);
  } catch (e: any) {
    res.status(500).send("CSV export failed: " + e.message);
  }
});

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
    res.send("✅ Auth complete. Now hit <a href='/employee-interactions'>/employee-interactions</a>.");
  } catch (e: any) {
    res.status(500).send(`OAuth error: ${e.message}`);
  }
});

// Debug: test LinkedIn /me
app.get("/test-linkedin", async (_req, res) => {
  try {
    const me = await httpGet("https://api.linkedin.com/v2/me");
    console.log("LinkedIn /me result:", me);
    res.json(me);
  } catch (err: any) {
    console.error("LinkedIn API test failed:", err);
    res.status(500).send(err.message);
  }
});

// ====== Boot ======
app.listen(cfg.port, () =>
  log.info(
    `Server http://localhost:${cfg.port} (mode=${cfg.mock ? "MOCK" : "LIVE"})`
  )
);
