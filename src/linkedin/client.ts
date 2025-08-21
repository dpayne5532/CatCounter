export interface LinkedInClient {
  getOrgUrnFromVanity(vanity: string): Promise<string>;
  getOrgPosts(orgUrn: string, count?: number): Promise<string[]>;
  getReactors(postUrn: string, count?: number): Promise<string[]>;
  getCommenters(postUrn: string, count?: number): Promise<string[]>;
}
