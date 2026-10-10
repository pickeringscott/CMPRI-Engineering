import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/work-order-suggestions.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('work-order-suggestions.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const functions = ast.statements
  .filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'separateIssueFromReporterNotes')
  .map((node) => node.getText(ast))
  .join('\n');
const exports = {};
vm.runInNewContext(ts.transpileModule(functions + '\nexports.split=separateIssueFromReporterNotes;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports });
const split = exports.split;

test('moves guest departure context into notes', () => {
  const result = split('TV is broken guest leaving to work');
  assert.equal(result.issue, 'TV is broken');
  assert.equal(result.reporterNotes, 'guest leaving to work');
});

test('moves guest return time into notes', () => {
  const result = split('AC not cooling guest to return by 3pm');
  assert.equal(result.issue, 'AC not cooling');
  assert.equal(result.reporterNotes, 'guest to return by 3pm');
});

test('moves occupancy context into notes', () => {
  const result = split('Sink leaking room is occupied');
  assert.equal(result.issue, 'Sink leaking');
  assert.equal(result.reporterNotes, 'room is occupied');
});

test('moves a guest departure time into notes without treating it as an issue', () => {
  const result = split('TV is broken\nGuest is going to leave at 5 PM');
  assert.equal(result.issue, 'TV is broken');
  assert.equal(result.reporterNotes, 'Guest is going to leave at 5 PM');
});

test('keeps guest-reported issue history in notes', () => {
  const result = split('Room 409. AC is not cooling. Guest says it started last night.');
  assert.equal(result.issue, 'Room 409. AC is not cooling.');
  assert.equal(result.reporterNotes, 'Guest says it started last night.');
});

test('a standalone guest departure comment contains no maintenance issue', () => {
  const result = split('Guest is going to leave at 5 PM');
  assert.equal(result.issue, '');
  assert.equal(result.reporterNotes, 'Guest is going to leave at 5 PM');
});

test('moves requests, history, and scheduling details into notes', () => {
  const result = split('Room 321 AC is not cooling\nPlease call the front desk before checkout\nCalled yesterday and this is still happening');
  assert.equal(result.issue, 'Room 321 AC is not cooling');
  assert.equal(result.reporterNotes, 'Please call the front desk before checkout\nCalled yesterday and this is still happening');
});

test('moves inline guest context and reporter opinion into notes', () => {
  const result = split('TV is broken; guest is upset and I think the remote may be the cause');
  assert.equal(result.issue, 'TV is broken');
  assert.equal(result.reporterNotes, 'guest is upset and I think the remote may be the cause');
});

test('keeps guest-room equipment symptoms as maintenance issues', () => {
  const result = split('Guest room TV is broken');
  assert.equal(result.issue, 'Guest room TV is broken');
  assert.equal(result.reporterNotes, '');
});

test('unwraps guest-reported appliance symptoms into the issue', () => {
  const result = split('Guest reports that the fridge makes loud noises');
  assert.equal(result.issue, 'the fridge makes loud noises');
  assert.equal(result.reporterNotes, '');
});

test('reporter-prefixed guest context remains a note', () => {
  const result = split('Guest reports that the guest is upset about the wait');
  assert.equal(result.issue, '');
  assert.equal(result.reporterNotes, 'Guest reports that the guest is upset about the wait');
});
