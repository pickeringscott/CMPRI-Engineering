// This preview never contacts provider APIs or production services.
// Adding keys alone must not silently enable an incompatible integration.
export function providerStatus(provider, configured = false) {
  if (provider === 'tenor') return {
    provider: 'tenor', status: 410, code: 'PROVIDER_RETIRED', items: [],
    message: 'Tenor search is unavailable. Google discontinued its third-party API on June 30, 2026.',
    documentation: 'https://support.google.com/tenor/answer/10455265?hl=en',
  };
  return {
    provider: 'giphy', status: 503, code: configured ? 'INTEGRATION_NOT_APPROVED' : 'NOT_CONFIGURED', items: [],
    message: configured
      ? 'GIPHY search is unavailable for this design. Its published rules prohibit server-proxied search and mixing providers in one grid.'
      : 'GIPHY search is not connected. No API key is configured; its rules also prohibit server-proxied search and a mixed-provider grid.',
    documentation: 'https://developers.giphy.com/docs/api/#prohibited-integration-practices',
  };
}
export function statusResponse(provider, configured) {
  const result = providerStatus(provider, configured);
  return Response.json(result, {status: result.status, headers: {'Cache-Control':'private, no-store'}});
}
