import { Context, Next } from "hono";
import { tokenStore } from "../auth/token-store.ts";
import { createLogger } from "../utils/logger.ts";

const logger = createLogger({ component: "middleware" });

function unauthorized(c: Context, description: string) {
  const baseUrl = new URL(c.req.url).origin;
  const metadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;

  c.header(
    "WWW-Authenticate",
    `Bearer resource_metadata="${metadataUrl}"`
  );

  return c.json(
    {
      error: "unauthorized",
      error_description: description,
    },
    401
  );
}

export async function authenticateBearer(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn("Authentication failed: missing or invalid Authorization header");
    return unauthorized(c, "Missing or invalid Authorization header");
  }

  const token = authHeader.substring(7);

  const isValid = await tokenStore.isValid(token);
  if (!isValid) {
    logger.warn("Authentication failed: invalid or expired token");
    return unauthorized(c, "Invalid or expired access token");
  }

  c.set("mcpToken", token);

  await next();
}
