import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { handleReact, handleSay, handleShowMedia, handleStatus, reactSchema, saySchema, showMediaSchema, type ToolContext } from "./tools.js";

export function createOpenPetsMcpServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: "open-pets", version: "0.0.0" }, {
    instructions: "Interact with the user's OpenPets desktop companion. Use openpets_status first. Use openpets_say only for short status/personality messages, never code, logs, secrets, URLs, or file paths. Use openpets_show_media only for an intentional local image the user should see.",
  });

  server.registerTool("openpets_status", {
    title: "OpenPets Status",
    description: "Check whether OpenPets is reachable and which pet MCP events currently target.",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async () => handleStatus(context));

  server.registerTool("openpets_react", {
    title: "OpenPets React",
    description: "Set a short coding-oriented reaction on the OpenPets desktop pet.",
    inputSchema: reactSchema,
    annotations: { readOnlyHint: false, idempotentHint: false },
  }, async (input) => handleReact(input, context));

  server.registerTool("openpets_say", {
    title: "OpenPets Say",
    description: "Show a short safe message on the OpenPets desktop pet. Do not send code, logs, secrets, URLs, or file paths.",
    inputSchema: saySchema,
    annotations: { readOnlyHint: false, idempotentHint: false },
  }, async (input) => handleSay(input, context));

  server.registerTool("openpets_show_media", {
    title: "OpenPets Show Media",
    description: "Show an intentional local PNG, JPG, WEBP, or GIF in the OpenPets pet bubble.",
    inputSchema: showMediaSchema,
    annotations: { readOnlyHint: false, idempotentHint: false },
  }, async (input) => handleShowMedia(input, context));

  return server;
}
