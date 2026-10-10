import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/server/auth";
import { createRoomOperationsOcrCrops, createRoomOperationsRecoveryCrops } from "@/lib/room-operations-report-images";

export const maxDuration = 60; // Allow up to 60 seconds for AI vision extraction
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await requireCapability(request, "edit_tickets");
  if (!auth) {
    return NextResponse.json({ error: "Engineering ticket-edit permission is required." }, { status: 403 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OpenAI API key (OPENAI_API_KEY) is not configured in the server environment. Please configure OPENAI_API_KEY to enable automatic AI image extraction." },
      { status: 503 }
    );
  }

  const images: Array<{ data: string; mediaType: string }> = [];
  let recoveryContext: { unresolved: string; previous_report_data?: unknown } | null = null;

  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    try {
      const formData = await request.formData();
      const rawRecoveryContext = formData.get("recovery_context");
      if (typeof rawRecoveryContext === "string" && rawRecoveryContext) {
        const parsed = JSON.parse(rawRecoveryContext) as { unresolved?: unknown; previous_report_data?: unknown };
        if (typeof parsed.unresolved !== "string" || parsed.unresolved.length > 8000) {
          return NextResponse.json({ error: "The automatic recovery request is invalid." }, { status: 400 });
        }
        recoveryContext = { unresolved: parsed.unresolved, previous_report_data: parsed.previous_report_data };
      }
      const files = formData.getAll("images")
        .concat(formData.getAll("files"))
        .concat(formData.getAll("file"))
        .concat(formData.getAll("image"));
      for (const item of files) {
        if (item instanceof File) {
          const buffer = await item.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          const mediaType = item.type || "image/jpeg";
          images.push({ data: base64, mediaType });
        }
      }
    } catch {
      return NextResponse.json({ error: "Failed to parse uploaded image files." }, { status: 400 });
    }
  } else {
    try {
      const body = await request.json();
      if (body.recovery_context && typeof body.recovery_context === "object" && !Array.isArray(body.recovery_context)) {
        const context = body.recovery_context as { unresolved?: unknown; previous_report_data?: unknown };
        if (typeof context.unresolved !== "string" || context.unresolved.length > 8000) {
          return NextResponse.json({ error: "The automatic recovery request is invalid." }, { status: 400 });
        }
        recoveryContext = { unresolved: context.unresolved, previous_report_data: context.previous_report_data };
      }
      const rawList: unknown[] = Array.isArray(body.images)
        ? body.images
        : body.image
        ? [body.image]
        : [];
      for (const item of rawList) {
        if (typeof item === "string") {
          const match = item.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
          if (match) {
            images.push({ mediaType: match[1], data: match[2] });
          } else {
            images.push({ mediaType: "image/jpeg", data: item });
          }
        } else if (item && typeof item === "object") {
          const obj = item as { data?: string; mediaType?: string; url?: string };
          if (obj.data) {
            images.push({
              mediaType: obj.mediaType || "image/jpeg",
              data: obj.data.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, ""),
            });
          }
        }
      }
    } catch {
      return NextResponse.json({ error: "Invalid extraction request payload." }, { status: 400 });
    }
  }

  if (!images.length) {
    return NextResponse.json({ error: "At least one RoomStatus or Departures image must be provided." }, { status: 400 });
  }

  const contentParts: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: `Extract the complete hotel room report data from every supplied page. Each uploaded page is supplied as two enlarged, slightly overlapping table crops. Merge overlapping crop evidence, but do not merge distinct rooms or omit out-of-order rows. Return ONLY one valid JSON object with this shape:
{
  "room_status": {
    "printed_date": "YYYY-MM-DD or empty if unreadable",
    "printed_time": "exact printed generation time or empty if absent/unreadable",
    "pages": [1],
    "rows": [{
      "room": "reported room identifier",
      "room_status": "exact reported status",
      "room_type": "current guest room type",
      "guest_name": "current guest first Name column",
      "guest_code": "current PP Code/Code",
      "guest_arrival_date": "current guest Arv",
      "checkout_date": "current guest Dep",
      "stay_nights": "current guest LOS",
      "reserved": "current Blk'd value",
      "incoming_name": "incoming/block Name column to the right of Due In",
      "incoming_type": "incoming/block Type column to the right of Due In",
      "incoming_code": "incoming/block code if shown",
      "incoming_arrival_date": "Due In",
      "incoming_arrival_time": "incoming arrival time if shown",
      "incoming_block_indicator": "reported incoming block/reservation indicator",
      "source_page": "page number"
    }]
  },
  "expected_departures": null or {
    "printed_date": "YYYY-MM-DD or empty if unreadable",
    "printed_time": "exact printed generation time or empty if absent/unreadable",
    "pages": [1],
    "rows": [{"room":"reported room","checkout_date":"reported date","checkout_time":"Dplm time"}]
  }
}

Rules:
1. Every supplied page must be represented in its report's pages array. Read the report's printed date and any printed generation time from the page itself, never from upload time. Do not infer missing values.
2. Include exactly one row for every room in the Room Status Report, including vacant, occupied, blocked, out-of-order and out-of-order abbreviated as OOO. Do not add rooms from Expected Departures. Ignore only non-room summary/footer rows.
3. Preserve exact status, names, codes, room types and block indicators as printed. Preserve special values such as RCNA, CN and Railway. Do not normalize or infer.
4. Map the Room Status Report's first Type after Room to current room_type; Arv, Dep, LOS, PP Code/Code and the first Name after PP Code/Code are current-guest details. Blk'd is the current room block value.
5. Keep the right-hand columns after Due In separate: capture its incoming Name, Type, code where shown, arrival date/time where shown, and block/reservation indicator. Never put incoming details in current-guest fields.
6. Match Expected Departures by room and copy its checkout date/time exactly when present. Do not add Expected Departures-only rooms. An absent expected-departures report is null.
7. Preserve compact dates such as 13Apr, 01Dec and 05Oct. An empty cell is an empty string. Use the exact string "[UNREADABLE]" for a required occupied/reservation detail that is present but cannot be read; never guess.
8. Include every room row, even when some conditional fields are genuinely blank. Do not silently omit out-of-order rows or replace their status.`,
    },
  ];

  try {
    for (const img of images) {
      const crops = recoveryContext
        ? await createRoomOperationsRecoveryCrops(Buffer.from(img.data, "base64"))
        : await createRoomOperationsOcrCrops(Buffer.from(img.data, "base64"));
      for (const crop of crops) {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${crop.toString("base64")}`,
            detail: "high",
          },
        });
      }
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? `A report image could not be enlarged for text extraction: ${err.message}` : "A report image could not be enlarged for text extraction." },
      { status: 422 }
    );
  }

  if (recoveryContext) {
    const previousReport = recoveryContext.previous_report_data
      ? `\n\nPrior extraction to reconcile (source evidence remains authoritative):\n${JSON.stringify(recoveryContext.previous_report_data).slice(0, 80000)}`
      : "";
    contentParts.push({
      type: "text",
      text: `AUTOMATIC RECOVERY PASS. Re-examine the supplied original report images using these enlarged overlapping crops. Focus on resolving only these specific rooms/fields: ${recoveryContext.unresolved}. Do not guess, fill blanks, or change other values unless the image clearly proves they were transcribed incorrectly. Preserve every already-extracted room and maintain full room/page coverage. Reconcile the result against the original images, not the prior extraction.${previousReport}`,
    });
  }

  try {
    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "You are an expert OCR system for hotel room operations reports. Transcribe source-backed values exactly into the requested JSON schema. Never guess or silently omit uncertain rows. Output only JSON.",
          },
          {
            role: "user",
            content: contentParts,
          },
        ],
        temperature: 0,
      }),
    });

    if (!openaiResponse.ok) {
      const errText = await openaiResponse.text();
      return NextResponse.json(
        { error: `OpenAI API error (${openaiResponse.status}): ${errText}`, retryable: openaiResponse.status >= 500 },
        { status: 502 }
      );
    }

    const data = await openaiResponse.json();
    const rawContent: string = data.choices?.[0]?.message?.content || "";
    const cleanJson = rawContent
      .replace(/^```(?:json|text)?\r?\n?/i, "")
      .replace(/\r?\n?```\s*$/i, "")
      .trim();
    if (!cleanJson) {
      return NextResponse.json({ error: "ChatGPT returned empty extraction data.", retryable: true }, { status: 422 });
    }
    let reportData: unknown;
    try {
      reportData = JSON.parse(cleanJson);
    } catch {
      return NextResponse.json({ error: "The extracted report is not valid JSON.", retryable: true }, { status: 422 });
    }
    if (
      !reportData
      || typeof reportData !== "object"
      || !("room_status" in reportData)
      || !("expected_departures" in reportData)
    ) {
      return NextResponse.json({ error: "The extracted report is missing its report identity or room rows.", retryable: true }, { status: 422 });
    }
    return NextResponse.json({ ok: true, report_data: reportData });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ChatGPT image extraction failed." },
      { status: 500 }
    );
  }
}
