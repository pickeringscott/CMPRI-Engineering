import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const HEADERS = { "Cache-Control": "private, no-store", Vary: "Authorization" };
const fields = ["title", "text", "fontSize", "strokes", "titleAutomatic", "mentions", "textStyles"] as const;
const patchSchema = z.object({
  title: z.string().max(120).optional(), text: z.string().max(100000).optional(),
  fontSize: z.number().optional(), strokes: z.array(z.unknown()).optional(),
  titleAutomatic: z.boolean().optional(), mentions: z.array(z.unknown()).optional(), textStyles: z.array(z.unknown()).optional(),
}).strict();
const schema = z.object({
  id: z.string().uuid(), changeId: z.string().uuid(), expectedRevision: z.number().int().positive(),
  patch: patchSchema.optional(), appendText: z.string().min(1).max(100000).optional(),
}).strict().refine(value => Object.keys(value.patch || {}).length > 0 || value.appendText !== undefined)
  .refine(value => value.appendText === undefined || value.patch?.text === undefined);

/** Merge only the requested fields into a freshly authorized native notebook document. */
export async function patchAskPersonalNote(request: NextRequest): Promise<Response> {
  let input: z.infer<typeof schema>;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 2_097_152) return NextResponse.json({ error: "This note change is too large." }, { status: 413, headers: HEADERS });
    input = schema.parse(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: "Choose an existing note, its current revision and the exact fields or text to change." }, { status: 400, headers: HEADERS });
  }
  const { GET, PUT } = await import("@/app/api/notes/route");
  const headers = new Headers();
  for (const name of ["authorization", "x-cmpri-property"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const url = new URL("/api/notes", request.url);
  url.searchParams.set("id", input.id);
  const read = await GET(new NextRequest(url, { headers, signal: request.signal }));
  if (!read.ok) return read;
  const result = await read.json() as { note?: Record<string, unknown> | null };
  request.signal.throwIfAborted();
  const note = result.note;
  if (!note) return NextResponse.json({ error: "This personal note is unavailable to the current account." }, { status: 404, headers: HEADERS });
  if (note.id !== input.id || !Number.isSafeInteger(note.revision) || typeof note.text !== "string") {
    return NextResponse.json({ error: "The current personal note could not be verified." }, { status: 503, headers: HEADERS });
  }
  if (note.revision !== input.expectedRevision) {
    return NextResponse.json({ error: "This note changed after it was read. Read the current note before reviewing another change." }, { status: 409, headers: HEADERS });
  }
  const document: Record<string, unknown> = Object.fromEntries(fields.filter(field => Object.hasOwn(note, field)).map(field => [field, note[field]]));
  Object.assign(document, input.patch);
  if (input.appendText !== undefined) document.text = note.text + input.appendText;
  // The native PUT validates complete text, ink, mentions, formatting, body size,
  // current account and the atomic revision/changeId. Omitted fields are untouched.
  headers.set("Content-Type", "application/json");
  return PUT(new NextRequest(new URL("/api/notes", request.url), {
    method: "PUT", headers, signal: request.signal,
    body: JSON.stringify({ id: input.id, changeId: input.changeId, expectedRevision: input.expectedRevision, document }),
  }));
}
