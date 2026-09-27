export type OverlayEntry = {
  id: string;
  kind: string;
};

export function openOverlay(stack: OverlayEntry[], entry: OverlayEntry): OverlayEntry[] {
  return [...stack.filter((item) => item.id !== entry.id), entry];
}

export function closeTopOverlay(stack: OverlayEntry[]): OverlayEntry[] {
  return stack.slice(0, -1);
}

export function topOverlay(stack: OverlayEntry[]): OverlayEntry | null {
  return stack[stack.length - 1] || null;
}

export function shouldLockScroll(stack: OverlayEntry[]): boolean {
  return stack.length > 0;
}
