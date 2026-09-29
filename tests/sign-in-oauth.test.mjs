import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const signInPage = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8');
const supabaseClient = readFileSync(new URL('../src/lib/supabase/client.ts', import.meta.url), 'utf8');

test('only an OAuth flow started in this tab is treated as a sign-in callback', () => {
  assert.match(signInPage, /function hasOAuthCallback\(\)\s*\{\s*return window\.sessionStorage\.getItem\(OAUTH_PENDING_KEY\) === "true";\s*\}/);
  assert.match(signInPage, /if \(session\) \{[\s\S]*?removeItem\(OAUTH_PENDING_KEY\)/);
});

test('signing out clears stale OAuth callback state', () => {
  assert.match(supabaseClient, /export const OAUTH_PENDING_KEY = "cmpri:auth:oauth-pending"/);
  assert.match(supabaseClient, /finally\s*\{\s*try\s*\{\s*window\.sessionStorage\.removeItem\(OAUTH_PENDING_KEY\);\s*\}\s*finally\s*\{\s*clearDeviceSessionStorage\(\);/);
});
