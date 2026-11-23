import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { notepadDocument, type NotepadBootstrap } from "@/lib/notepad";

const HEADERS = { "Cache-Control": "private, no-store", Vary: "Authorization" };
const patchSchema = z.object({
  title: z.string().optional(), content: z.string().optional(),
  audience: z.object({ all: z.boolean(), roles: z.array(z.string()), people: z.array(z.string()) }).strict().optional(),
  priority: z.enum(["Low", "Normal", "High", "Urgent"]).optional(),
  fontSize: z.number().optional(), fontFamily: z.string().optional(), titleFontFamily: z.string().optional(),
  ink: z.array(z.unknown()).optional(), itemThreads: z.record(z.string(), z.unknown()).optional(),
  attachments: z.array(z.unknown()).optional(),
}).strict();
const schema = z.object({
  id: z.string().uuid(), changeId: z.string().uuid(), expectedRevision: z.number().int().nonnegative(),
  expectedLegacyVersion: z.string().max(200).optional(),
  patch: patchSchema.optional(), appendText: z.string().min(1).max(100000).optional(),
}).strict().refine(value => Object.keys(value.patch || {}).length > 0 || value.appendText !== undefined)
  .refine(value => value.appendText === undefined || value.patch?.content === undefined);

export function notepadPlainParagraph(text: string, itemId: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/\r\n?|\n/g, "<br>");
  return `<p data-item-id="${itemId}">${escaped}</p>`;
}

/** Read through the same audience check as the UI and retain every omitted field. */
export async function patchAskNotepad(request: NextRequest): Promise<Response> {
  let input: z.infer<typeof schema>;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 2_097_152) return NextResponse.json({ error: "This note change is too large." }, { status: 413, headers: HEADERS });
    input = schema.parse(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: "Choose an existing Notepad note, its current revision and the exact fields or text to change." }, { status: 400, headers: HEADERS });
  }
  const { GET, PUT } = await import("@/app/api/notepad/route");
  const headers = new Headers();
  for (const name of ["authorization", "x-cmpri-property"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const url = new URL("/api/notepad", request.url);
  const read = await GET(new NextRequest(url, { headers, signal: request.signal }));
  if (!read.ok) return read;
  const result = await read.json() as NotepadBootstrap;
  request.signal.throwIfAborted();
  const note = result.notes?.find(value => value.id === input.id);
  if (!note) return NextResponse.json({ error: "This Notepad note is unavailable to the current account." }, { status: 404, headers: HEADERS });
  if (!Number.isSafeInteger(note.revision) || typeof note.content !== "string") {
    return NextResponse.json({ error: "The current Notepad note could not be verified." }, { status: 503, headers: HEADERS });
  }
  if (note.revision !== input.expectedRevision || (input.expectedLegacyVersion !== undefined && note.legacyVersion !== input.expectedLegacyVersion)) {
    return NextResponse.json({ error: "This note changed after it was read. Read the current note before reviewing another change." }, { status: 409, headers: HEADERS });
  }
  const document = { ...notepadDocument(note), ...input.patch };
  if (input.appendText !== undefined) document.content = note.content + notepadPlainParagraph(input.appendText, "append-" + input.changeId);
  headers.set("Content-Type", "application/json");
  // The native save sanitizes the complete document, verifies current sharing,
  // stamps checklist/reply authors, and compares revision/changeId atomically.
  return PUT(new NextRequest(url, { method: "PUT", headers, signal: request.signal,
    body: JSON.stringify({ id: input.id, changeId: input.changeId, expectedRevision: input.expectedRevision, expectedLegacyVersion: note.revision === 0 ? note.legacyVersion : undefined, document }),
  }));
}
