import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveMcpWorkOrderLocation } from "../src/lib/ai/mcp-work-order-location.ts";
import { isSubmitOnlyRole } from "../src/lib/server/roles.ts";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("profile connection UI explains per-user ChatGPT OAuth and connection revocation", () => {
  const page = source("../src/app/profile/ai-connection/page.tsx");
  const consent = source("../src/app/mcp/authorize/page.tsx");
  const profile = source("../src/app/profile/page.tsx");
  const dashboard = source("../src/app/engineering/page.tsx");
  const route = source("../src/app/api/profile/ai-connection/route.ts");
  const mcpAuth = source("../src/lib/server/cmpri-mcp-auth.ts");
  assert.match(page, /Connect ChatGPT/);
  assert.match(page, /Connect with secure OAuth/);
  assert.match(page, /Each user authorizes their own CMPRI account/);
  assert.match(page, /select <strong>OAuth<\/strong>/);
  assert.match(page, /OpenAI API credits are separate from OAuth/);
  assert.match(page, /Revoke ChatGPT access/);
  assert.match(page, /remove the CMPRI app from ChatGPT/);
  assert.match(page, /approve <strong>read and write<\/strong> access/);
  assert.match(consent, /Authorize read-only access/);
  assert.match(consent, /provider: "google"/);
  assert.match(consent, /Continue with Google/);
  assert.match(consent, /email address was added to your CMPRI profile/);
  assert.match(consent, /read and write access/);
  assert.doesNotMatch(page, /type="password"|api_key|Load models/);
  assert.match(profile, /ChatGPT Connection/);
  assert.match(profile, /Connect ChatGPT/);
  assert.match(profile, /Connect ChatGPT with secure per-user OAuth/);
  assert.match(dashboard, /payload\.chatgpt_connection\?\.connected === true/);
  assert.match(dashboard, /Connect ChatGPT/);
  assert.doesNotMatch(dashboard, /personalAiConnected|Connect OpenAI/);
  assert.match(route, /requireUser\(request\)/);
  assert.doesNotMatch(route, /isSubmitOnlyRole/);
  assert.match(route, /allows\(auth\.principal, "submit"\)/);
  assert.match(route, /cmpri_personal_mcp_links/);
  assert.match(route, /revoked_at/);
  assert.match(route, /Private-link connections are retired/);
  assert.match(route, /status: 410/);
  assert.doesNotMatch(mcpAuth, /isSubmitOnlyRole/);
});

test("submit-only roles retain the profile UI restriction without blocking ChatGPT authentication", () => {
  for (const role of ["Front Desk", "Housekeeping", "Lead Housekeeper"]) {
    assert.equal(isSubmitOnlyRole(role), true, `${role} should be submit-only`);
  }
  for (const role of ["Engineer", "Manager", "Technician", "Senior Management", "Front Desk Manager"]) {
    assert.equal(isSubmitOnlyRole(role), false, `${role} should retain ChatGPT eligibility`);
  }
  const profile = source("../src/app/profile/page.tsx");
  assert.match(profile, /canManageChatgptConnection\s*=\s*!\s*isSubmitOnlyRole\(data\?\.profile\.role\)/);
});

test("legacy personal MCP links remain valid but new profile links are disabled in favor of OAuth", () => {
  const migration = source("../supabase/migrations_archive/20260929010000_cmpri_personal_mcp_links.sql");
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
  assert.match(profileRoute, /Private-link connections are retired/);
  assert.match(profileRoute, /status: 410/);
  assert.match(profileRoute, /personal_link_active/);
});

test("ChatGPT work-order room resolution requires a unique exact active location", () => {
  const locations = [
    { id: "room-110", name: "Guest Room", room_number: "110" },
    { id: "room-111", name: "Guest Room", room_number: "111" },
  ];
  assert.deepEqual(resolveMcpWorkOrderLocation("Room 110", locations), {
    status: "found",
    location: locations[0],
  });
  assert.deepEqual(resolveMcpWorkOrderLocation("999", locations), { status: "not_found" });
  assert.deepEqual(resolveMcpWorkOrderLocation("Room 110", [
    ...locations,
    { id: "duplicate", name: "110", room_number: "different" },
  ]), { status: "ambiguous" });
});

test("ChatGPT OAuth supports read/write scopes with dynamic registration, PKCE, one-time codes, and rotated opaque tokens", () => {
  const oauth = source("../src/lib/server/cmpri-mcp-oauth.ts");
  const oauthScopes = source("../src/lib/server/cmpri-mcp-oauth-scope.ts");
  const constants = source("../src/lib/constants.ts");
  const mcpServer = source("../src/lib/server/cmpri-mcp.ts");
  const connectionPage = source("../src/app/profile/ai-connection/page.tsx");
  const consentPage = source("../src/app/mcp/authorize/page.tsx");
  const authorizationMetadata = source("../src/app/.well-known/oauth-authorization-server/route.ts");
  const resourceMetadata = source("../src/app/.well-known/oauth-protected-resource/route.ts");
  const resourceMetadataCatchAll = source("../src/app/.well-known/oauth-protected-resource/[...resource]/route.ts");
  const mcpRoute = source("../src/app/api/mcp/route.ts");
  const nextConfig = source("../next.config.ts");
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
  assert.match(oauthScopes, /CMPRI_MCP_RESOURCE = "https:\/\/www\.cmpri-engineering\.com\/api\/mcp"/);
  assert.match(constants, /CANONICAL_APP_URL = "https:\/\/cmpri-engineering\.com"/);
  assert.match(`${mcpServer}\n${connectionPage}\n${consentPage}`, /CMPRI_MCP_RESOURCE/);
  assert.match(mcpServer, /endpoint: CMPRI_MCP_RESOURCE/);
  assert.match(connectionPage, /endpoint: CMPRI_MCP_RESOURCE/);
  assert.match(consentPage, /resource: params\.get\("resource"\) \|\| CMPRI_MCP_RESOURCE/);
  assert.match(authorizationMetadata, /const origin = new URL\(CMPRI_MCP_RESOURCE\)\.origin;[\s\S]*issuer: origin/);
  assert.match(authorizationMetadata, /authorization_endpoint: `\$\{origin\}\/mcp\/authorize`/);
  assert.match(resourceMetadata, /resource: CMPRI_MCP_RESOURCE,[\s\S]*authorization_servers: \[new URL\(CMPRI_MCP_RESOURCE\)\.origin\]/);
  assert.match(resourceMetadataCatchAll, /resource: CMPRI_MCP_RESOURCE,[\s\S]*authorization_servers: \[new URL\(CMPRI_MCP_RESOURCE\)\.origin\]/);
  assert.match(mcpRoute, /new URL\(CMPRI_MCP_RESOURCE\)\.origin[\s\S]*oauth-protected-resource/);
  assert.doesNotMatch(nextConfig, /www\\\.cmpri-engineering/);
  assert.match(token, /revoked_at/);
  assert.match(revoke, /token_family_id/);
  assert.doesNotMatch(`${register}\n${authorize}\n${token}`, /OPENAI_API_KEY|api_key_encrypted/);
});

test("MCP tools apply the connected CMPRI user's current permissions and gate database writes", () => {
  const route = source("../src/app/api/mcp/route.ts");
  const identity = source("../src/lib/server/cmpri-mcp-auth.ts");
  const writes = source("../src/lib/server/cmpri-mcp-writes.ts");
  const writeInput = source("../src/lib/ai/mcp-write-input.ts");
  const reads = source("../src/lib/server/cmpri-mcp-reads.ts");
  const auth = source("../src/lib/server/auth.ts");
  const authorizePage = source("../src/app/mcp/authorize/page.tsx");
  assert.match(route, /search_work_orders/);
  assert.match(route, /search_locations/);
  assert.match(route, /create_work_order/);
  assert.match(route, /No active CMPRI room exactly matches/);
  assert.match(route, /location_id: resolution\.location\.id/);
  assert.match(route, /issue,/);
  assert.match(route, /work_orders\.create/);
  assert.match(route, /get_work_order/);
  assert.match(route, /search_equipment/);
  assert.match(route, /read_cmpri_data/);
  assert.match(route, /availableMcpReadViews\(identity\)/);
  assert.match(route, /readOnlyHint: true/);
  assert.match(route, /perform_cmpri_write/);
  assert.match(route, /availableMcpWriteActions\(identity\)/);
  assert.match(writes, /allows\(identity\.principal, action\.capability\)/);
  assert.match(writes, /@\/app\/api\/work-orders\/route/);
  assert.match(writes, /@\/app\/api\/work-orders\/\[id\]\/route/);
  assert.match(writes, /normalizeMcpWorkOrderUpdate\(input\)/);
  assert.match(writes, /normalizeMcpFeedbackInput\(input\)/);
  assert.match(writes, /expected_revision from the latest work-order read/);
  assert.match(writeInput, /In Progress/);
  assert.match(reads, /allows\(identity\.principal, capability\)/);
  assert.match(reads, /@\/app\/api\/engineering\/operations\/route/);
  assert.match(reads, /@\/app\/api\/work-orders\/\[id\]\/attachments\/route/);
  assert.match(reads, /availableMcpReadViews\(identity\)\.includes\(view\)/);
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
  const migration = source("../supabase/migrations_archive/20260928230000_cmpri_chatgpt_mcp_oauth.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.cmpri_mcp_oauth_clients/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.cmpri_mcp_oauth_codes/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.cmpri_mcp_oauth_tokens/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON public\.cmpri_mcp_oauth_tokens FROM anon, authenticated/);
  assert.match(migration, /personal_ai_api_key_encrypted = NULL/);
  assert.match(migration, /personal_ai_connected = false/);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|ALTER TABLE public\.(?!cmpri_mcp_oauth)/i);
});
