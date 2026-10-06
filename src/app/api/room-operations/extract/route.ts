import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/server/auth";
import { createRoomOperationsOcrCrops } from "@/lib/room-operations-report-images";

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

  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    try {
      const formData = await request.formData();
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
      text: `Extract and validate all room operations data from these hotel report image(s) (Room Status Report and/or Expected Departures Report). Each uploaded page is supplied as two enlarged, slightly overlapping table crops. Combine the evidence across crops and pages.
Return ONLY valid CSV text in this exact format:

Room,Room Status,Guest Name,Room Type,LOS,Blocked,Departure Date,Departure Time,Incoming Arrival Date,Incoming Arrival Time,Guest Code,Guest Arrival Date

Extraction rules:
1. Output ONLY the raw CSV text. Do not wrap in markdown backticks or commentary. Because crops overlap, output each room only once and combine the clearest field values across both crops.
2. The Room Status Report is the source of the room rows: include exactly one data row for EVERY room shown there, including vacant, occupied, blocked, and out-of-order rooms. Use an Expected Departures report only as supplemental data for matching rooms; do not add rooms from that report. Ignore non-room summary/footer rows (e.g., Total Clean, Occupancy %, Grand Total, Page numbers).
3. Map the Room Status Report columns exactly as follows: Room → Room; Status → Room Status; first Type column after Room → Room Type; Arv → Guest Arrival Date (current guest); Dep → Departure Date (current guest); LOS → LOS; PP Code/Code → Guest Code (current guest); first Name column immediately after PP Code/Code → Guest Name (current guest); Blk'd → Blocked; Due In → Incoming Arrival Date.
4. Ignore ODH. Ignore the second Type and second Name columns to the right of Due In; those describe the incoming blocked booking and must not replace the current guest's type or name.
5. Room: 2 to 4 digit room number or MGR (all uppercase).
6. Room Status: Transcribe Status exactly as shown, including abbreviations such as VR, VD, and OOO. Never infer it from guest, arrival, or departure data. Leave it blank only if visibly blank or unreadable.
7. Guest Name: Transcribe the current guest's first Name column exactly, including punctuation and slash-separated names (for example RAILWAY/CN-NJ8). Leave blank only when that cell is blank or unreadable. Do not substitute the incoming booking's second Name column.
8. Room Type: Transcribe the first Type column after Room, or blank.
9. LOS: Length of stay as a whole number (0 if empty/vacant).
10. Blocked: Yes if Blk'd contains any block/reservation value (including a numeric confirmation number); otherwise No.
11. Departure Date: Copy the current guest's Dep value. Compact dates such as 13Apr or 01Dec must be preserved exactly. Leave blank if absent.
12. Departure Time: Match the room against the Expected Departures report's Rm # column and copy its Dplm time; if there is no time, leave blank.
13. Incoming Arrival Date: Copy Due In, preserving compact dates such as 05Oct exactly. Incoming Arrival Time: extract if present or leave blank.
14. Guest Code: Copy the current guest's PP Code/Code. Guest Arrival Date: Copy the current guest's Arv value, preserving the original text.
15. Include every room shown, even when some fields are blank. Never omit OOO rooms or replace their reported status.`,
    },
  ];

  try {
    for (const img of images) {
      const crops = await createRoomOperationsOcrCrops(Buffer.from(img.data, "base64"));
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
            content: "You are an expert OCR system for hotel room operations reports. You transcribe hotel report images into the exact CSV format requested. Output only CSV.",
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
        { error: `OpenAI API error (${openaiResponse.status}): ${errText}` },
        { status: 502 }
      );
    }

    const data = await openaiResponse.json();
    const rawContent: string = data.choices?.[0]?.message?.content || "";
    const cleanCsv = rawContent
      .replace(/^```(?:csv|tsv|text)?\r?\n?/i, "")
      .replace(/\r?\n?```\s*$/i, "")
      .trim();

    if (!cleanCsv) {
      return NextResponse.json({ error: "ChatGPT returned empty extraction data." }, { status: 422 });
    }

    return NextResponse.json({ ok: true, csv: cleanCsv });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ChatGPT image extraction failed." },
      { status: 500 }
    );
  }
}
