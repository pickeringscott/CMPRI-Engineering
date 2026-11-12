import { NextRequest, NextResponse } from 'next/server';
import { createHash, createHmac } from 'node:crypto';
import { createSupabaseAdmin } from '@/lib/server/supabase-admin';
import { cleanupExpiredEmploymentUploads } from '@/lib/server/employment-resume-cleanup';
import { validateEmployment } from '@/lib/employment-validation.mjs';

export const maxDuration = 300;
const LIMIT = 100 * 1024 * 1024;
const BUCKET = 'employment-resumes';
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };
const reply = (error: string, status = 400) => NextResponse.json({ error }, { status, headers });
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

// Public applicants receive only a write-once capability for their own random
// object. Neither application IDs nor upload capabilities authorize any reads.
export async function PUT(request: NextRequest) {
  try {
    const origin = new URL(request.headers.get('origin') || '');
    if (origin.host !== request.headers.get('host') || (origin.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && origin.protocol === 'http:'))) return reply('Invalid origin.', 403);
  } catch { return reply('Invalid origin.', 403); }
  let body;
  try {
    const reader = request.body?.getReader();
    if (!reader) return reply('Upload details required.');
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > 16000) { await reader.cancel(); return reply('Upload details are too large.', 413); }
      chunks.push(part.value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || !['prepare', 'finalize'].includes(body.action)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.id)
      || typeof body.capability !== 'string' || !/^[a-f0-9]{64}$/.test(body.capability)
      || typeof body.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.sha256)
      || !Number.isSafeInteger(body.size) || body.size < 5 || body.size > LIMIT
      || typeof body.name !== 'string' || body.name.length > 180 || !/\.pdf$/i.test(body.name)
      || /[\\/\x00-\x1f\x7f]/.test(body.name) || body.answers?.website) return reply('Choose a valid PDF of at most 100 MB and complete the questionnaire.');
  } catch { return reply('Check the questionnaire and PDF attachment.'); }
  body.id = body.id.toLowerCase();
  const validation = validateEmployment(body.answers);
  if (!validation.ok || !validation.value) return reply('Check the required fields.');
  const admin = createSupabaseAdmin();
  if (!admin) return reply('Submission temporarily unavailable.', 503);
  const capabilityHash = hash(body.capability);
  const path = `${body.id}/${body.sha256}.pdf`;
  const storage = admin.storage.from(BUCKET);
  if (body.action === 'prepare') {
    // Vercel overwrites this header. Never trust arbitrary X-Forwarded-For.
    const ip = request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim();
    if (process.env.NODE_ENV === 'production' && (!process.env.VERCEL || !ip)) return reply('Upload admission is unavailable.', 503);
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!secret) return reply('Upload admission is unavailable.', 503);
    const ipHash = createHmac('sha256', secret).update('employment-upload-ip:' + (ip || 'local-development')).digest('hex');
    await cleanupExpiredEmploymentUploads(admin);
    const admission = await admin.rpc('prepare_employment_resume_upload', {
      p_id: body.id, p_answers: validation.value, p_file_name: body.name, p_size: body.size,
      p_sha256: body.sha256, p_capability_hash: capabilityHash, p_ip_hash: ipHash,
    });
    if (admission.error) return reply('Upload could not be admitted. Keep this form and retry later.', admission.error.code === 'P0001' ? 429 : 503);
    if (admission.data === 'complete') return NextResponse.json({ ok: true, complete: true, id: body.id }, { headers });
    const bucket = await admin.storage.getBucket(BUCKET);
    if (bucket.error || !bucket.data || bucket.data.public || bucket.data.file_size_limit !== LIMIT) return reply('Private resume storage is unavailable.', 503);
    const signed = await storage.createSignedUploadUrl(path, { upsert: false });
    if (signed.error || !signed.data) return reply('Upload could not be prepared. Retry with this form.', 503);
    return NextResponse.json({ ok: true, signedUrl: signed.data.signedUrl }, { headers });
  }
  // Verify possession and the exact bound submission before reading any object.
  const pending = await admin.from('employment_resume_uploads').select('answers,file_name,file_size,sha256,expires_at,completed_at')
    .eq('id', body.id).eq('capability_hash', capabilityHash).maybeSingle();
  const item = pending.data;
  if (pending.error) return reply('Submission temporarily unavailable.', 503);
  if (!item || item.file_name !== body.name || item.file_size !== body.size || item.sha256 !== body.sha256
    || canonical(item.answers) !== canonical(validation.value)) return reply('Upload does not match this submission.', 403);
  if (item.completed_at) return NextResponse.json({ ok: true, complete: true, id: body.id }, { status: 201, headers });
  if (Date.parse(item.expires_at) < Date.now()) return reply('This upload expired. Start a new application.', 410);
  const info = await storage.info(path);
  if (info.error || !info.data) return reply('The PDF upload is not complete. Retry with this form.', 409);
  if (info.data.size !== body.size || info.data.contentType !== 'application/pdf') return reply('The uploaded PDF does not match the selected file.');
  const downloaded = await storage.download(path);
  if (downloaded.error || !downloaded.data) return reply('The PDF could not be verified. Retry with this form.', 503);
  if (downloaded.data.size !== body.size) return reply('The uploaded PDF size does not match.');
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  if (Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-' || hash(bytes) !== body.sha256) return reply('The uploaded file is not the selected PDF.');
  const saved = await admin.rpc('finalize_employment_resume_upload', { p_id: body.id, p_capability_hash: capabilityHash });
  if (saved.error) return reply('Submission unavailable. Retry without changing the form.', saved.error.code === 'P0001' ? 409 : 503);
  return NextResponse.json({ ok: true, complete: true, id: body.id }, { status: 201, headers });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
