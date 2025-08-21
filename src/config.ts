import dotenv from "dotenv";
dotenv.config();

export const cfg = {
  port: Number(process.env.PORT || 3000),
  clientId: process.env.CLIENT_ID || "",
  clientSecret: process.env.CLIENT_SECRET || "",
  redirectUri: process.env.REDIRECT_URI || "http://localhost:3000/callback",
  version: process.env.LINKEDIN_VERSION || "202507",
  vanity: process.env.VANITY || "catalyst-solutions-llc",
  mock: String(process.env.MOCK || "true").toLowerCase() === "true"
};
