import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const components = [
  ['src/app/engineering/gss/GssSourceReportView.tsx', 1],
  ['src/components/StaffNotesMedia.tsx', 4],
  ['src/components/WorkOrderAttachmentHistory.tsx', 2],
  ['src/components/WorkOrderMediaComposer.tsx', 1],
  ['src/components/PdfHtmlPreview.tsx', 1],
];

for (const [path, count] of components) test(`${path}: native media stays in layout-neutral picture elements`, () => {
  const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(file.parseDiagnostics.length, 0);
  const images = [];
  function visit(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === 'img') images.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.equal(images.length, count);
  for (const image of images) {
    const picture = image.parent;
    assert.ok(ts.isJsxElement(picture));
    assert.equal(picture.openingElement.tagName.getText(file), 'picture');
    assert.equal(picture.children.length, 1);
    const style = picture.openingElement.attributes.properties.find(prop => prop.name?.getText(file) === 'style');
    assert.match(style?.getText(file) || '', /display:\s*['"]contents['"]/);
    assert.ok(image.attributes.properties.some(prop => prop.name?.getText(file) === 'src'));
    assert.ok(image.attributes.properties.some(prop => prop.name?.getText(file) === 'alt'));
  }
  assert.doesNotMatch(source, /eslint-disable.*no-img-element|from ['"]next\/image['"]/);
});

test('modal scan retains the Playwright function-expression contract', () => {
  const source = readFileSync(new URL('./browser/modal_element_scan.js', import.meta.url), 'utf8');
  const scan = vm.runInNewContext(source);
  assert.equal(typeof scan, 'function');
  assert.match(scan.toString(), /selector \|\|=/);
});
