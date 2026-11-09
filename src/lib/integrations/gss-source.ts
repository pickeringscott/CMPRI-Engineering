/** Selection of the two source images is deliberately strict: a changed email
 * layout must be reviewed instead of exposing other sections of the mailbox. */
export type GssMimePart = { mimeType?: string; headers?: { name: string; value: string }[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: GssMimePart[] };

export function gssSourceDate(from: string, subject: string): string | null {
  const address = from.match(/<([^<>]+)>/)?.[1] || from.trim();
  if (address.toLowerCase() !== 'taylor.johnson@hawkeyehotels.com') return null;
  const match = subject.trim().match(/^Hawkeye Hotel Weekly GSS Update\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})$/i);
  if (!match) return null;
  const [month, day, year] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export function marriottImageParts(html: string, payload: GssMimePart): [GssMimePart, GssMimePart] {
  // Only the distinct Marriott section bounded by the Hilton heading qualifies.
  const sections = [...html.matchAll(/<span\b[^>]*>\s*Marriott\s*<\/span\s*>([\s\S]*?)<span\b[^>]*>\s*Hilton\s*<\/span\s*>/gi)];
  if (sections.length !== 1) throw new Error('Unrecognized GSS layout');
  const images = [...sections[0][1].matchAll(/<img\b[^>]*>/gi)];
  if (images.length !== 2) throw new Error('Unrecognized GSS images');
  const cids = images.map(([tag]) => tag.match(/\bsrc\s*=\s*["']cid:([^"']+)["']/i)?.[1]);
  if (cids.some(cid => !cid || !/^[\w.%-]{1,200}$/.test(cid)) || cids[0] === cids[1]) throw new Error('Invalid GSS image references');
  const parts: GssMimePart[] = [];
  const visit = (part: GssMimePart) => { parts.push(part); for (const child of part.parts || []) visit(child); };
  visit(payload);
  const selected = cids.map(cid => parts.filter(part => part.mimeType?.toLowerCase() === 'image/png' && part.headers?.some(header => header.name.toLowerCase() === 'content-id' && header.value.trim().replace(/^<|>$/g, '') === cid)));
  if (selected.some(matches => matches.length !== 1)) throw new Error('Missing or ambiguous GSS images');
  return [selected[0][0], selected[1][0]];
}

export function safeGssPng(bytes: Buffer): string {
  if (bytes.length < 24 || bytes.length > 3 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid GSS image');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 500 || height < 250 || width > 4096 || height > 4096) throw new Error('Invalid GSS image dimensions');
  return `data:image/png;base64,${bytes.toString('base64')}`;
}
