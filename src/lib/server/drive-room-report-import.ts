import { createHash } from 'node:crypto';

type ApiResult = { status: number; body: Record<string, unknown> | null };
/** Connected-account access to the same on-demand fetch/preview/confirm flow as the UI. */
export async function runDriveRoomReportImport(
  input: Record<string, unknown>,
  acquire: () => Promise<ApiResult>,
  importReports: (body: Record<string, unknown>) => Promise<ApiResult>,
): Promise<ApiResult> {
  if (Object.keys(input).some(key => !['source', 'validate_only', 'previousId', 'source_digest'].includes(key))) {
    return { status: 400, body: { error: 'Drive imports accept source, validate_only, previousId and source_digest only.' } };
  }
  const preview = input.validate_only === true;
  if (!preview && (input.validate_only !== false || !Object.hasOwn(input, 'previousId') || typeof input.source_digest !== 'string')) {
    return { status: 400, body: { error: 'Preview the Drive reports first. Confirmation requires validate_only: false, previousId and source_digest returned by that preview.' } };
  }
  const fetched = await acquire();
  if (fetched.status !== 200) return fetched;
  const files = fetched.body?.files;
  if (!Array.isArray(files)) return { status: 502, body: { error: 'Drive reports could not be verified.' } };
  if (!files.length) return { status: 200, body: { ok: true, imported: false, message: 'No newer reports for today were found in the attachment folder.' } };
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  if (!preview && digest !== input.source_digest) return { status: 409, body: { error: 'The Drive reports changed after preview. Fetch and review them again.' } };
  const result = await importReports({ files, validateOnly: preview, ...(preview ? {} : { previousId: input.previousId }) });
  if (result.status !== 200 || !preview) return result;
  return { status: 200, body: { ...result.body, validate_only: true, source_digest: digest, report_names: files.map(file => file.name) } };
}
