/** Original files explicitly selected for this private Ask conversation. */
export const ASK_FILE_LIMIT = 100 * 1024 * 1024;
export const ASK_FILE_COUNT = 20;
export type AskFileDescriptor = { id: string; name: string; type: string; size: number; sha256: string };
export type AskStagedFile = AskFileDescriptor & { token: string; expiresAt: number };
