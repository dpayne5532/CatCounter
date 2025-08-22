import fetch from "node-fetch";
import type { LinkedInClient } from "./client.js";
import { cfg } from "../config.js";

let ACCESS_TOKEN = ""; // demo only
let EXPIRES_AT = 0;

const H = () => ({
  Authorization: `Bearer ${ACCESS_TOKEN}`,
  "LinkedIn-Version": cfg.version,
  "X-Restli-Protocol-Version": "2.0.0"
});

const enc = encodeURIComponent;

async function httpGet(url: string, extra: Record<string, string> = {}): Promise<any> {
  if (!ACCESS_TOKEN) throw new Error("Not authenticated. Visit /login first.");
  if (Date.now() >= EXPIRES_AT) throw new Error("Access token expired. Re-login.");
  const r = await fetch(url, { headers: { ...H(), ...extra } });
  if (!r.ok) throw new Error(`LinkedIn GET ${r.status}: ${await r.text()}`);
  return (await r.json()) as any; // loosen typing for now
}

export async function exchangeCodeForToken(code: string) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret
  });
  const r = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) throw new Error(`Token exchange failed ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  ACCESS_TOKEN = j.access_token;
  EXPIRES_AT = Date.now() + j.expires_in * 1000 - 60_000;
}

export class RestLinkedIn implements LinkedInClient {
  async getOrgUrnFromVanity(vanity: string): Promise<string> {
    const url = `https://api.linkedin.com/rest/organizations?q=vanityName&vanityName=${enc(vanity)}`;
    const j: any = await httpGet(url);
    const el = (j.elements || [])[0];
    if (!el?.id) throw new Error(`No org for ${vanity}`);
    return `urn:li:organization:${el.id}`;
  }

  async getOrgPosts(orgUrn: string, count = 50): Promise<string[]> {
    const url = `https://api.linkedin.com/rest/posts?q=author&author=${enc(orgUrn)}&count=${count}&sortBy=LAST_MODIFIED`;
    const j: any = await httpGet(url, { "X-RestLi-Method": "FINDER" });
    const items = j?.elements ?? j?.results ?? [];
    return items.map((p: any) => p.id).filter(Boolean);
  }

  async getReactors(postUrn: string, count = 100): Promise<string[]> {
    const url = `https://api.linkedin.com/rest/reactions/(entity:${enc(postUrn)})?q=entity&count=${count}`;
    const j: any = await httpGet(url);
    const els = j?.elements || [];
    return els
      .map((r: any) => String(r.id || "").match(/urn:li:person:[A-Za-z0-9_-]+/)?.[0] || null)
      .filter(Boolean) as string[];
  }

  async getCommenters(postUrn: string, count = 100): Promise<string[]> {
    const url = `https://api.linkedin.com/rest/socialActions/${enc(postUrn)}/comments?count=${count}`;
    const j: any = await httpGet(url);
    const els = j?.elements || [];
    return els.map((c: any) => c.actor).filter((a: string) => a?.startsWith("urn:li:person:"));
  }
}
