import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("profile connection UI issues a private no-OAuth MCP link scoped to the signed-in CMPRI account", () => {
  const page = source("../src/app/profile/ai-connection/page.tsx");
  const consent = source("../src/app/mcp/authorize/page.tsx");
  const profile = source("../src/app/profile/page.tsx");
  const dashboard = source("../src/app/engineering/page.tsx");
  const route = source("../src/app/api/profile/ai-connection/route.ts");
  assert.match(page, /Connect ChatGPT/);
  assert.match(page, /No Authentication/);
  assert.match(page, /Developer mode/);
  assert.match(page, /Create connection link/);
  assert.match(page, /Treat this URL like a password/);
  assert.match(consent, /Authorize read-only access/);
  assert.match(consent, /provider: "google"/);
  assert.match(consent, /Continue with Google/);
  assert.match(consent, /email address was added to your CMPRI profile/);
  assert.match(consent, /read and write access/);
  assert.doesNotMatch(page, /type="password"|api_key|Load models/);
  assert.match(profile, /ChatGPT Connection/);
  assert.match(profile, /Connect ChatGPT/);
  assert.match(profile, /private no-OAuth connection link for an AI app/);
  assert.match(dashboard, /payload\.chatgpt_connection\?\.connected === true/);
  assert.match(dashboard, /Connect ChatGPT/);
  assert.doesNotMatch(dashboard, /personalAiConnected|Connect OpenAI/);
  assert.match(route, /requireUser\(request\)/);
  assert.match(route, /allows\(auth\.principal, "submit"\)/);
  assert.match(route, /cmpri_personal_mcp_links/);
  assert.match(route, /randomPersonalMcpLinkToken/);
  assert.match(route, /365 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(route, /revoked_at/);
});

test("personal MCP links authenticate the user without an OAuth exchange and preserve normal MCP permission checks", () => {
  const migration = source("../supabase/migrations/20260929010000_cmpri_personal_mcp_links.sql");
  const route = source("../src/app/api/mcp/personal/[token]/route.ts");
  const identity = source("../src/lib/server/cmpri-mcp-auth.ts");
  const profileRoute = source("../src/app/api/profile/ai-connection/route.ts");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.cmpri_personal_mcp_links/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(route, /cmpri_link_/);
  assert.match(route, /POST as mcpPost/);
  assert.match(route, /responseHeaders\.delete\("WWW-Authenticate"\)/);
  assert.match(identity, /cmpri_personal_mcp_links/);
  assert.match(identity, /token\.scope === CMPRI_MCP_WRITE_SCOPE/);
  assert.match(profileRoute, /hashOAuthToken\(token\)/);
  assert.match(profileRoute, /expires_at/);
  assert.match(profileRoute, /personal_link_active/);
});

test("ChatGPT OAuth supports read/write scopes with dynamic registration, PKCE, one-time codes, and rotated opaque tokens", () => {
  const oauth = source("../src/lib/server/cmpri-mcp-oauth.ts");
  const oauthScopes = source("../src/lib/server/cmpri-mcp-oauth-scope.ts");
  const register = source("../src/app/oauth/register/route.ts");
  const authorize = source("../src/app/oauth/authorize/route.ts");
  const token = source("../src/app/oauth/token/route.ts");
  const revoke = source("../src/app/oauth/revoke/route.ts");
  assert.match(oauth, /createHash\("sha256"\)/);
  assert.match(oauth, /createHash\("sha256"\).*digest\("base64url"\)/s);
  assert.match(oauth, /protocol === "https:"/);
  assert.match(register, /redirect_uris/);
  assert.match(authorize, /requireUser\(request\)/);
  assert.match(authorize, /allows\(auth\.principal, "view_dashboard"\)/);
  assert.match(authorize, /code_challenge_method !== "S256"/);
  assert.match(token, /\.is\("used_at", null\)/);
  assert.match(token, /refresh_token/);
  assert.match(token, /pending\.scope/);
  assert.match(oauthScopes, /CMPRI_MCP_WRITE_SCOPE = "cmpri:read cmpri:write"/);
  assert.match(oauthScopes, /normalizeMcpScope/);
  assert.match(token, /revoked_at/);
  assert.match(revoke, /token_family_id/);
  assert.doesNotMatch(`${register}\n${authorize}\n${token}`, /OPENAI_API_KEY|api_key_encrypted/);
});

test("MCP tools apply the connected CMPRI user's current permissions and gate database writes", () => {
  const route = source("../src/app/api/mcp/route.ts");
  const identity = source("../src/lib/server/cmpri-mcp-auth.ts");
  const writes = source("../src/lib/server/cmpri-mcp-writes.ts");
  const auth = source("../src/lib/server/auth.ts");
  const authorizePage = source("../src/app/mcp/authorize/page.tsx");
  assert.match(route, /search_work_orders/);
  assert.match(route, /get_work_order/);
  assert.match(route, /search_equipment/);
  assert.match(route, /readOnlyHint: true/);
  assert.match(route, /perform_cmpri_write/);
  assert.match(route, /availableMcpWriteActions\(identity\)/);
  assert.match(writes, /allows\(identity\.principal, action\.capability\)/);
  assert.match(writes, /@\/app\/api\/work-orders\/route/);
  assert.match(writes, /@\/app\/api\/work-orders\/\[id\]\/route/);
  assert.match(auth, /isMutatingMethod\(request\.method\) && !mcp\.canWrite/);
  assert.match(identity, /token\.scope === CMPRI_MCP_WRITE_SCOPE/);
  assert.match(identity, /cmpri_mcp_oauth_tokens/);
  assert.match(identity, /allows\(principal, "view_dashboard"\)/);
  assert.match(identity, /hotel_members/);
  assert.match(identity, /role_permissions/);
  assert.match(identity, /allows\(principal, "submit"\)/);
  assert.match(authorizePage, /getValidSession\(\)/);
  assert.match(authorizePage, /user\.role/);
  assert.match(authorizePage, /permissions will be checked on every tool request/);
});

test("one deliberate migration creates isolated OAuth storage and retires saved API credentials", () => {
  const migration = source("../supabase/migrations/20260928230000_cmpri_chatgpt_mcp_oauth.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.cmpri_mcp_oauth_clients/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.cmpri_mcp_oauth_codes/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.cmpri_mcp_oauth_tokens/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON public\.cmpri_mcp_oauth_tokens FROM anon, authenticated/);
  assert.match(migration, /personal_ai_api_key_encrypted = NULL/);
  assert.match(migration, /personal_ai_connected = false/);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|ALTER TABLE public\.(?!cmpri_mcp_oauth)/i);
});
