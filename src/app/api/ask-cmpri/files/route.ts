import { NextRequest, NextResponse } from "next/server";
import { AskFileAccessError, finalizeAskFile, prepareAskFile, removeAskFile } from "@/lib/server/ask-cmpri-file-staging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Authorization" };
async function run(request: NextRequest, action: (request: NextRequest, input: unknown) => Promise<unknown>) {
  try {
    const raw = await request.text();
    if (raw.length > 12000) return NextResponse.json({ error: "Invalid original-file reference." }, { status: 400, headers });
    return NextResponse.json(await action(request, JSON.parse(raw)), { headers });
  } catch (error) {
    if (request.signal.aborted) throw error;
    const message = error instanceof Error ? error.message : "The original file could not be prepared.";
    return NextResponse.json({ error: message }, { status: error instanceof AskFileAccessError ? error.status : 400, headers });
  }
}
export async function POST(request: NextRequest) { return run(request, prepareAskFile); }
export async function PUT(request: NextRequest) { return run(request, finalizeAskFile); }
export async function DELETE(request: NextRequest) { return run(request, removeAskFile); }
