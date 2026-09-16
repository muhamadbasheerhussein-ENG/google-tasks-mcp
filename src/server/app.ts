import process from "node:process";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { readFile } from "node:fs/promises";
import { createOAuthRouter } from "../auth/oauth.ts";
import { authenticateBearer } from "./middleware.ts";
import { handleMcpGet, handleMcpPost } from "./mcp-endpoints.ts";

export interface ServerConfig {
  oauthConfig: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
}

const MCP_ENDPOINT = "/mcp";

export function createApp(config: ServerConfig) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();

    if (c.req.url.startsWith("https://")) {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }

    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    if (!c.res.headers.get("Content-Security-Policy")) {
      c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    }
    c.header("Referrer-Policy", "no-referrer");
    c.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  });

  app.use("*", cors({
    origin: (origin) => {
      if (!origin) return "*";
      if (origin.match(/^https?:\/\/localhost(:\d+)?$/) || origin.match(/^https?:\/\/127\.0\.0\.1(:\d+)?$/)) return origin;
      const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || [];
      if (allowedOrigins.includes(origin)) return origin;
      return null;
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id", "Accept"],
    exposeHeaders: ["Mcp-Session-Id", "Content-Type", "WWW-Authenticate"],
    credentials: false,
    maxAge: 86400,
  }));

  // Compatibility: some MCP clients have been observed to send the
  // authenticated post-OAuth MCP request to the origin root. Preserve the
  // normal landing page for browser/unauthenticated GET requests, while
  // routing authenticated root requests to the MCP transport.
  app.get("/", async (c) => {
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      return authenticateBearer(c, () => handleMcpGet(c));
    }

    try {
      const html = await readFile("./public/index.html", "utf-8");
      c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://www.googletagmanager.com; connect-src https://www.google-analytics.com; frame-ancestors 'none'");
      return c.html(html);
    } catch {
      return c.json({ message: "Google Tasks MCP Server" });
    }
  });

  app.post("/", authenticateBearer, handleMcpPost);

  app.route("/", createOAuthRouter(config.oauthConfig));

  app.get("/auth/callback", (c) => {
    const url = new URL(c.req.url);
    url.pathname = "/callback";
    return c.redirect(url.toString());
  });

  app.get(MCP_ENDPOINT, authenticateBearer, handleMcpGet);
  app.post(MCP_ENDPOINT, authenticateBearer, handleMcpPost);

  const protectedResourceMetadata = (c: any) => {
    const baseUrl = new URL(c.req.url).origin;
    return c.json({
      resource: `${baseUrl}${MCP_ENDPOINT}`,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ["header"],
      resource_documentation: `${baseUrl}/`,
    });
  };

  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);

  app.get("/.well-known/oauth-authorization-server", (c) => {
    const baseUrl = new URL(c.req.url).origin;
    return c.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      mcp_endpoint: `${baseUrl}${MCP_ENDPOINT}`,
    });
  });

  app.get("/favicon.ico", async (c) => {
    try {
      const file = await readFile("./public/favicon.ico");
      return c.body(file, 200, { "Content-Type": "image/x-icon" });
    } catch {
      return c.notFound();
    }
  });

  app.get("/privacy-policy", async (c) => {
    try {
      const html = await readFile("./public/privacy-policy.html", "utf-8");
      c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://www.googletagmanager.com; connect-src https://www.google-analytics.com; frame-ancestors 'none'");
      return c.html(html);
    } catch {
      return c.notFound();
    }
  });

  app.get("/health", async (c) => {
    try {
      const html = await readFile("./public/health.html", "utf-8");
      c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://www.googletagmanager.com; connect-src https://www.google-analytics.com; frame-ancestors 'none'");
      return c.html(html);
    } catch {
      return c.json({ status: "ok" });
    }
  });

  app.onError((err, c) => {
    console.error("Unhandled error:", err);
    return c.json({
      error: "internal_server_error",
      error_description: "An internal server error occurred. Please try again later."
    }, 500);
  });

  return app;
}
