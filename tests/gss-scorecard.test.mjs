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
function renderModule(relativePath, overrides = {}, props = {}) {
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
    return renderToStaticMarkup(createElement(load(file).default, props));
}
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
test('GSS replacement retains accessible source tables and its own approved typography', () => {
    const page = read('../src/app/engineering/gss/page.tsx');
    assert.match(page, /<GssScorecard \/>/);
    assert.match(page, /hasCapability\(session, "view_engineering_operations"\)/);
    const html = renderModule('../src/app/engineering/gss/GssScorecard.tsx');
    assert.equal((html.match(/<table/g) || []).length, 6);
    assert.equal((html.match(/data-property=/g) || []).length, 30);
    assert.equal((html.match(/Source trend: /g) || []).length, 36);
    assert.equal((html.match(/2026 ITR Thresholds/g) || []).length, 2);
    assert.match(html, /Verified report · November 9, 2026/);
    for (const date of ['2026-11-02', '2026-10-26', '2026-10-19']) assert.ok(html.includes(date));
    assert.match(html, /data-property="Residence Inn by Marriott Champaign \(CMPRI\)"[^]*?<td data-label="Sample Size">6<\/td>[^]*?<td data-label="Intent to Recommend \(Property\)">83\.3<\/td>/);
    assert.match(html, /dateTime="2026-11-02"[^]*?<th scope="row">October<\/th><td data-label="Sample Size">31<\/td><td data-label="Intent to Recommend \(Property\)">48\.4<\/td>/);
    assert.match(html, /scope="col"/);
    assert.match(html, /scope="row"/);
    assert.doesNotMatch(html, /<img|<canvas|vs. prior week/);
});

test('ranking labels use the supplied report date and actual property count', () => {
    const html = renderModule('../src/app/engineering/gss/FullRanking.tsx', {}, {
        reportDateLabel: 'November 9, 2026',
        ranking: { period: 'MTD', rows: [
            { property: 'Example', sampleSize: 3, scores: [1, 2, 3, 4, 5, 6], color: 'clear', trend: 'flat' },
        ] },
    });
    assert.match(html, /Marriott Rankings MTD, November 9, 2026/);
    assert.match(html, /All 1 property in the November 9, 2026 Marriott Rankings MTD source graphic/);
    assert.match(html, /Source trend: flat/);
    assert.doesNotMatch(html, /October 12, 2026|All 15 properties/);
});

test('source report shows only reports newer than the verified tables', () => {
    const view = '../src/app/engineering/gss/GssSourceReportView.tsx';
    const images = [{ period: 'First ranking', dataUrl: 'data:image/png;base64,YQ==' }, { period: 'Second ranking', dataUrl: 'data:image/png;base64,Yg==' }];
    const render = state => renderModule(view, {}, { state, verifiedDate: '2026-11-09' });
    assert.match(render({ status: 'loading' }), /Checking for the latest/);
    assert.match(render({ status: 'error' }), /could not be loaded.*November 9, 2026/);
    for (const date of ['2026-11-02', '2026-11-09']) {
        const html = render({ status: 'ready', report: { date, images } });
        assert.match(html, /No newer source report was found/);
        assert.doesNotMatch(html, /<img/);
    }
    const newer = render({ status: 'ready', report: { date: '2026-11-16', images } });
    assert.match(newer, /November 16, 2026/);
    assert.match(newer, /First ranking in the Marriott GSS report dated November 16, 2026/);
    assert.match(newer, /Second ranking in the Marriott GSS report dated November 16, 2026/);
    assert.match(newer, /verified tables below are from an earlier report/);
});

test('source report rejects partial or malformed responses', () => {
    const source = read('../src/app/engineering/gss/GssSourceReportView.tsx');
    const exports = {};
    new Function('require', 'exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)(name => name.endsWith('.css') ? {} : require(name), exports);
    const image = period => ({ period, dataUrl: 'data:image/png;base64,YQ==' });
    assert.ok(exports.parseSourceReport({ date: '2026-11-16', images: [image('First ranking'), image('Second ranking')] }));
    assert.equal(exports.parseSourceReport({ date: '2026-02-30', images: [image('First ranking'), image('Second ranking')] }), null);
    assert.equal(exports.parseSourceReport({ date: '2026-11-16', images: [image('First ranking')] }), null);
    assert.equal(exports.parseSourceReport({ date: '2026-11-16', images: [image('First ranking'), image('First ranking')] }), null);
    assert.equal(exports.parseSourceReport({ date: '2026-11-16', images: [image('First ranking'), { period: 'Second ranking', dataUrl: 'https://example.com/image.png' }] }), null);
});


test('GSS uses shared embedded Dashboard visibility',()=>{
    // GSS delegates iframe awareness to the shared Dashboard control.
    assert.match(read('../src/app/engineering/gss/page.tsx'), /<ModalDashboardLink/);
    const control = '../src/components/ModalDashboardLink.tsx';
    assert.equal(renderModule(control, { '@/components/use-embedded-modal': () => true }), '');
    assert.match(renderModule(control, { '@/components/use-embedded-modal': () => false }), /data-cmpri-modal-dashboard="true"/);
});
