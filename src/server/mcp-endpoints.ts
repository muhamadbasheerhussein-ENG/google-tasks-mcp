import { Context } from "hono";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { registerAllTools } from "../tools/index.ts";
import { createLogger } from "../utils/logger.ts";

const logger = createLogger({ component: "mcp-endpoints" });

/**
 * Serve MCP using the official web-standard Streamable HTTP handler.
 *
 * The previous implementation used a custom SSE transport for POST requests.
 * Claude's remote MCP connector expects Streamable HTTP semantics for /mcp,
 * including initialize and tools/list discovery. createMcpHandler provides
 * those semantics and remains stateless by default for legacy 2025-era MCP
 * clients as well.
 */
async function handleMcpRequest(c: Context) {
  const mcpToken = c.get("mcpToken") as string;

  try {
    const handler = createMcpHandler(() => {
      const server = new McpServer(
        {
          name: "google-tasks-mcp",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        },
      );

      registerAllTools(server, mcpToken);
      return server;
    });

    return await handler.fetch(c.req.raw);
  } catch (error) {
    logger.error("Failed to handle Streamable HTTP MCP request", error);
    return c.json(
      {
        error: "internal_server_error",
        error_description: "Failed to handle MCP request",
      },
      500,
    );
  }
}

export function handleMcpGet(c: Context) {
  return handleMcpRequest(c);
}

export function handleMcpPost(c: Context) {
  return handleMcpRequest(c);
}
