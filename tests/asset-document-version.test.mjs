import test from 'node:test';
import assert from 'node:assert/strict';
import { afterDocumentSave } from '../src/lib/asset-document-version.ts';

test('a PDF save advances only the matching asset version without losing edits', () => {
  const draft = { id: 'asset-1', updated_at: 'before', name: 'Unsaved equipment edit' };
  assert.deepEqual(afterDocumentSave(draft, 'asset-1', 'before', 'after'), { ...draft, updated_at: 'after' });
  assert.strictEqual(afterDocumentSave(draft, 'asset-1', 'older', 'after'), draft);
  assert.strictEqual(afterDocumentSave(draft, 'other-asset', 'before', 'after'), draft);
});
