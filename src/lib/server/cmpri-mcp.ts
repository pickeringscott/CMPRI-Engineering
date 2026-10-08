import "server-only";

import { CMPRI_MCP_RESOURCE, CMPRI_MCP_WRITE_SCOPE } from "@/lib/server/cmpri-mcp-oauth-scope";

export { mcpIdentity, type McpIdentity } from "@/lib/server/cmpri-mcp-auth";

export function connectionFromActiveTokens(scopes: readonly string[] | null, error: unknown) {
  if (error) throw new Error("ChatGPT connection status could not be loaded.");
  const activeScopes = scopes || [];
  const connected = activeScopes.length > 0;
  const writeEnabled = activeScopes.includes(CMPRI_MCP_WRITE_SCOPE);
  return {
    connected,
    status: connected ? "active" as const : "disconnected" as const,
    access: writeEnabled ? "read_write" as const : connected ? "read_only" as const : "disconnected" as const,
    provider: "ChatGPT",
    endpoint: CMPRI_MCP_RESOURCE,
    message: writeEnabled
      ? "ChatGPT is connected with read and write access limited to your current CMPRI permissions."
      : connected
        ? "ChatGPT is connected with read-only access. Disconnect and reconnect to grant write access."
        : "ChatGPT signs in to CMPRI. CMPRI applies your current account permissions to every tool call.",
  };
}
