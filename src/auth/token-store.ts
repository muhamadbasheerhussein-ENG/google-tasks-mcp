import { openKv } from "@deno/kv";
import { encrypt, decrypt } from "../utils/encryption.ts";

export interface TokenData {
  googleAccessToken: string;
  googleRefreshToken: string;
  expiresAt: number;
  resource: string;
}

interface EncryptedTokenData {
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  expiresAt: number;
  resource: string;
}

class TokenStore {
  private kv: Awaited<ReturnType<typeof openKv>> | null = null;

  async init() {
    this.kv = await openKv();
  }

  async storeTokens(mcpToken: string, tokenData: TokenData): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    const TTL_MS = 30 * 24 * 60 * 60 * 1000;

    const encryptedData: EncryptedTokenData = {
      encryptedAccessToken: encrypt(tokenData.googleAccessToken),
      encryptedRefreshToken: encrypt(tokenData.googleRefreshToken),
      expiresAt: tokenData.expiresAt,
      resource: tokenData.resource,
    };

    await this.kv.set(["tokens", mcpToken], encryptedData, { expireIn: TTL_MS });
  }

  async getTokens(mcpToken: string): Promise<TokenData | null> {
    if (!this.kv) throw new Error("KV not initialized");
    const result = await this.kv.get<EncryptedTokenData>(["tokens", mcpToken]);

    if (!result.value) {
      return null;
    }

    return {
      googleAccessToken: decrypt(result.value.encryptedAccessToken),
      googleRefreshToken: decrypt(result.value.encryptedRefreshToken),
      expiresAt: result.value.expiresAt,
      resource: result.value.resource,
    };
  }

  async isValid(mcpToken: string, expectedResource?: string): Promise<boolean> {
    const data = await this.getTokens(mcpToken);
    if (!data) return false;
    return expectedResource ? data.resource === expectedResource : true;
  }

  async updateTokens(mcpToken: string, updates: Partial<TokenData>): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    const existing = await this.getTokens(mcpToken);
    if (!existing) throw new Error("Token not found");

    const updatedData: TokenData = {
      ...existing,
      ...updates,
    };

    const encryptedData: EncryptedTokenData = {
      encryptedAccessToken: encrypt(updatedData.googleAccessToken),
      encryptedRefreshToken: encrypt(updatedData.googleRefreshToken),
      expiresAt: updatedData.expiresAt,
      resource: updatedData.resource,
    };

    const TTL_MS = 30 * 24 * 60 * 60 * 1000;
    await this.kv.set(["tokens", mcpToken], encryptedData, { expireIn: TTL_MS });
  }

  async deleteToken(mcpToken: string): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    await this.kv.delete(["tokens", mcpToken]);
  }
}

export const tokenStore = new TokenStore();
