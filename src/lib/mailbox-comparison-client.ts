const fields = ["clientSecretSha256", "refreshTokenSha256"] as const;
export async function submitMailboxComparison(raw: string, token: () => Promise<string>, send: typeof fetch = fetch) {
  const invalid = () => new Error("Paste only the reference JSON from the private hashing utility.");
  if (raw.length > 512) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
  const input = parsed as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || !fields.every(key => typeof input[key] === "string" && input[key].length === 64 && /^[a-f0-9]+$/.test(input[key]))) throw invalid();
  const body = JSON.stringify({clientSecretSha256:input.clientSecretSha256,refreshTokenSha256:input.refreshTokenSha256});
  try {
    const accessToken = await token();
    if (!accessToken) throw new Error();
    const response = await send("/api/engineering/operations", {method:"POST",cache:"no-store",headers:{authorization:`Bearer ${accessToken}`,"content-type":"application/json"},body});
    if (!response.ok) throw new Error();
    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    const values = result as Record<string, unknown>;
    const keys = ["sourceClientSecretMatchesReference","outgoingClientSecretMatchesReference","sourceRefreshTokenMatchesReference","outgoingRefreshTokenMatchesReference"] as const;
    if (!keys.every(key=>typeof values[key]==="boolean")) throw new Error();
    return keys.map(key=>values[key] as boolean);
  } catch { throw new Error("Comparison unavailable. Check your sign-in and integration access, then retry."); }
}
