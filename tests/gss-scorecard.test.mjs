import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const require = createRequire(import.meta.url);
function renderModule(relativePath, overrides = {}) {
    const file = fileURLToPath(new URL(relativePath, import.meta.url));
    function load(target) {
        const compiled = ts.transpileModule(readFileSync(target, 'utf8'), { compilerOptions: {
            module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
        } }).outputText;
        const mod = { exports: {} };
        new Function('require', 'module', 'exports', compiled)(name => {
            if (Object.hasOwn(overrides, name)) return overrides[name];
            if (name.endsWith('.css')) return new Proxy({}, { get: (_, key) => key === '__esModule' ? false : key });
            if (name.startsWith('.')) {
                const base = resolve(dirname(target), name);
                try { return load(base + '.tsx'); } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                    return load(base + '.ts');
                }
            }
            return require(name);
        }, mod, mod.exports);
        return mod.exports;
    }
    return renderToStaticMarkup(createElement(load(file).default));
}
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
test('GSS replacement retains accessible source tables and its own approved typography', () => {
    const page = read('../src/app/engineering/gss/page.tsx');
    assert.match(page, /<GssLive \/>/);
    assert.match(page, /hasCapability\(session, "view_engineering_operations"\)/);
    const html = renderModule('../src/app/engineering/gss/GssScorecard.tsx');
    assert.equal((html.match(/<table/g) || []).length, 6);
    assert.equal((html.match(/data-property=/g) || []).length, 30);
    assert.equal((html.match(/Source trend: /g) || []).length, 36);
    assert.equal((html.match(/2026 ITR Thresholds/g) || []).length, 2);
    assert.match(html, /October 12, 2026/);
    for (const date of ['2026-10-05', '2026-09-28', '2026-09-21']) assert.ok(html.includes(date));
    assert.match(html, /scope="col"/);
    assert.match(html, /scope="row"/);
    assert.doesNotMatch(html, /<img|<canvas|vs. prior week/);
});


test('GSS uses shared embedded Dashboard visibility',()=>{
    // GSS delegates iframe awareness to the shared Dashboard control.
    assert.match(read('../src/app/engineering/gss/page.tsx'), /<ModalDashboardLink/);
    const control = '../src/components/ModalDashboardLink.tsx';
    assert.equal(renderModule(control, { '@/components/use-embedded-modal': () => true }), '');
    assert.match(renderModule(control, { '@/components/use-embedded-modal': () => false }), /data-cmpri-modal-dashboard="true"/);
});
