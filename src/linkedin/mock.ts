import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { LinkedInClient } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(path.join(__dirname, "../../fixtures", p), "utf8"));

export class MockLinkedIn implements LinkedInClient {
  async getOrgUrnFromVanity(vanity: string) { return `urn:li:organization:MOCK_${vanity}`; }
  async getOrgPosts(_orgUrn: string, _count = 50) { return read("sample.posts.json"); }
  async getReactors(postUrn: string, _count = 100) { const m = read("sample.reactions.json"); return m[postUrn] || []; }
  async getCommenters(postUrn: string, _count = 100) { const m = read("sample.comments.json"); return m[postUrn] || []; }
}
