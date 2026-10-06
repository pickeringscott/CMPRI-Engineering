export type WorkOrderImage = {
  id: string;
  name: string;
  url: string;
};

export type WorkOrderImageResolution = {
  images: WorkOrderImage[];
  error: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workOrderImage(value: unknown): WorkOrderImage | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id.trim()) return null;
  if (typeof value.name !== "string" || !value.name.trim()) return null;
  if (typeof value.url !== "string" || !value.url.trim()) return null;
  return { id: value.id, name: value.name, url: value.url };
}

export function resolveWorkOrderImages(responseOk: boolean, payload: unknown): WorkOrderImageResolution {
  if (!isRecord(payload)) {
    return {
      images: [],
      error: responseOk ? "Work-order images returned an invalid response." : "Work-order images could not be loaded.",
    };
  }
  if (!responseOk) {
    return {
      images: [],
      error: typeof payload.error === "string" && payload.error.trim()
        ? payload.error
        : "Work-order images could not be loaded.",
    };
  }
  if (!Array.isArray(payload.images)) {
    return { images: [], error: "Work-order images returned an invalid response." };
  }
  const images: WorkOrderImage[] = [];
  for (const value of payload.images) {
    const image = workOrderImage(value);
    if (!image) return { images: [], error: "Work-order images returned an invalid response." };
    images.push(image);
  }
  return { images, error: "" };
}
