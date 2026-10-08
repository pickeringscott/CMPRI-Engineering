export const CMPRI_MCP_RESOURCE = "https://www.cmpri-engineering.com/api/mcp";
export const CMPRI_MCP_SCOPE = "cmpri:read";
export const CMPRI_MCP_WRITE_SCOPE = "cmpri:read cmpri:write";

export function normalizeMcpScope(scope: string): typeof CMPRI_MCP_SCOPE | typeof CMPRI_MCP_WRITE_SCOPE | null {
  const values = scope.trim().split(/\s+/);
  if (values.includes("cmpri:read") && values.every((value) => value === "cmpri:read" || value === "cmpri:write")) {
    return values.includes("cmpri:write") ? CMPRI_MCP_WRITE_SCOPE : CMPRI_MCP_SCOPE;
  }
  return null;
}

export function validMcpScope(scope: string): scope is typeof CMPRI_MCP_SCOPE | typeof CMPRI_MCP_WRITE_SCOPE {
  return normalizeMcpScope(scope) === scope;
}
