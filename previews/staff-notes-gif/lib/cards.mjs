const domains = {giphy: ['giphy.com','www.giphy.com'], tenor: ['tenor.com','www.tenor.com']};
function safeUrl(value, provider, media = false) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const allowed = media ? url.hostname === `${provider}.com` || url.hostname.endsWith(`.${provider}.com`) : domains[provider]?.includes(url.hostname);
    return allowed ? value : null;
  } catch { return null; }
}
// Standard external link card, never a downloaded file or blob.
export function externalCard(item) {
  if (!domains[item?.provider] || typeof item.id !== 'string') return null;
  const canonicalUrl = safeUrl(item.canonicalUrl, item.provider);
  const previewUrl = safeUrl(item.previewUrl, item.provider, true);
  if (!canonicalUrl || !previewUrl) return null;
  return {kind:'external-link', provider:item.provider, id:item.id.slice(0,200),
    title:String(item.title || 'GIF').slice(0,200), canonicalUrl, previewUrl,
    width:Math.max(1, Math.min(2000, Number(item.width) || 200)),
    height:Math.max(1, Math.min(2000, Number(item.height) || 150)),
    attribution:item.provider === 'giphy' ? 'GIPHY' : 'Tenor'};
}
export function mergeResults(results) {
  const lists = results.map(result => (result.items || []).map(externalCard).filter(Boolean));
  const seen = new Set(), merged = [];
  for (let i=0; i<Math.max(0,...lists.map(list=>list.length)); i++) {
    for (const list of lists) {
      const card=list[i];
      if (card && !seen.has(`${card.provider}:${card.id}`)) {
        seen.add(`${card.provider}:${card.id}`); merged.push(card);
      }
    }
  }
  return merged;
}
