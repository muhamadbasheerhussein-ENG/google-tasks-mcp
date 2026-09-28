import { Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { HonoSSETransport } from "../transport/mcp-transport.ts";
import { registerAllTools } from "../tools/index.ts";
import { createLogger } from "../utils/logger.ts";

const logger = createLogger({ component: "mcp-endpoints" });

export function handleMcpGet(c: Context) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const heartbeat = setInterval(() => {
    writer.write(encoder.encode(": ping\n\n")).catch(() => {
      clearInterval(heartbeat);
    });
  }, 15000);

  c.req.raw.signal.addEventListener("abort", () => {
    clearInterval(heartbeat);
    writer.close().catch(() => {});
  });

  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  };

  return new Response(readable, { headers });
}

export async function handleMcpPost(c: Context) {
  const mcpToken = c.get("mcpToken") as string;

  let message: JSONRPCMessage;
  try {
    message = await c.req.json() as JSONRPCMessage;
  } catch {
    logger.error("Failed to parse incoming MCP message");
    return c.json({
      error: "invalid_request",
      error_description: "Request body is not valid JSON",
    }, 400);
  }

  const incoming = message as { method?: string; id?: string | number };
  logger.info(`MCP incoming method=${incoming.method ?? "<response/unknown>"} id=${incoming.id ?? "<none>"}`);

  // Claude now probes remote MCP servers with the 2026-07-28 server/discover
  // method before falling back to the legacy initialize handshake. This server
  // still uses the v1 MCP SDK / 2025-era protocol, so advertise that explicitly
  // instead of returning -32601. Do NOT claim 2026-07-28 support until the
  // server is migrated to the v2 SDK and modern wire format.
  if (incoming.method === "server/discover") {
    const discoveryResponse = {
      jsonrpc: "2.0",
      id: incoming.id,
      result: {
        resultType: "complete",
        supportedVersions: ["2025-06-18", "2025-03-26", "2024-11-05"],
        capabilities: {
          tools: {},
        },
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "google-tasks-mcp",
            version: "1.0.0",
          },
        },
        instructions: "Google Tasks MCP server. Use the legacy MCP initialize handshake and tools capability.",
        ttlMs: 0,
        cacheScope: "private",
      },
    };

    logger.info("MCP discovery probe answered with legacy protocol versions and tools capability");
    return new Response(`data: ${JSON.stringify(discoveryResponse)}\n\n`, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let streamClosed = false;

  const closeStream = () => {
    if (streamClosed) {
      return;
    }
    streamClosed = true;
    writer.close().catch(() => {});
  };

  const writeSSE = async (data: string, event?: string) => {
    if (streamClosed) {
      return;
    }
    try {
      if (event) {
        await writer.write(encoder.encode(`event: ${event}\n`));
      }
      await writer.write(encoder.encode(`data: ${data}\n\n`));
    } catch {
      // Silently handle write errors (e.g. client disconnected)
    }
  };

  const transport = new HonoSSETransport();
  transport.attachStream({
    writeSSE: async (data: { data: string; event?: string; id?: string }) => {
      try {
        const outgoing = JSON.parse(data.data) as {
          id?: string | number;
          method?: string;
          result?: { tools?: unknown[] };
          error?: { code?: number; message?: string };
        };
        const toolCount = Array.isArray(outgoing.result?.tools)
          ? outgoing.result!.tools!.length
          : undefined;
        logger.info(
          `MCP outgoing id=${outgoing.id ?? "<none>"} method=${outgoing.method ?? "<response>"}` +
            `${toolCount !== undefined ? ` tools=${toolCount}` : ""}` +
            `${outgoing.error ? ` error=${outgoing.error.code ?? "?"}:${outgoing.error.message ?? "unknown"}` : ""}`,
        );
      } catch {
        logger.info("MCP outgoing non-JSON SSE payload");
      }

      await writeSSE(data.data, data.event);
      closeStream();
    },
    close: () => {
      closeStream();
    },
  });

  (async () => {
    try {
      const sessionServer = new McpServer(
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

      registerAllTools(sessionServer, mcpToken);

      await sessionServer.connect(transport);
      logger.info("MCP request handled statelessly via POST");

      await transport.handleIncomingMessage(message);

      setTimeout(() => {
        closeStream();
      }, 30000);
    } catch (error) {
      logger.error(`Failed to handle MCP message via POST: ${error instanceof Error ? error.message : String(error)}`);
      closeStream();
    }
  })();

  c.req.raw.signal.addEventListener("abort", () => {
    closeStream();
  });

  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  };

  return new Response(readable, { headers });
}
