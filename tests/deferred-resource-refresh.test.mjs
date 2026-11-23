import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { loadTs } from "./helpers/load-ts.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://cmpri.test/engineering" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(blocked = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let notify, stopped = false;
  const reads = [], applied = [], responses = [];
  const topics = ["reference", "rooms"];
  const { useDeferredResourceRefresh } = loadTs("src/lib/events/use-deferred-resource-refresh.ts", {
    react: React,
    "./browser": { subscribeResources: (selected, load, initial) => {
      assert.equal(selected, topics);
      assert.equal(initial, false, "the existing page load remains responsible for first paint");
      notify = load;
      return () => { stopped = true; };
    } },
  });
  let props = { blocked, context: "first" };
  function Harness({ blocked, context }) {
    useDeferredResourceRefresh(topics, blocked, async isCurrent => {
      reads.push(context);
      const value = await (responses.shift() || Promise.resolve(context));
      if (isCurrent()) applied.push(value);
    }, context);
    return null;
  }
  async function render(change = {}) {
    props = { ...props, ...change };
    await act(async () => { root.render(React.createElement(Harness, props)); await settle(); });
  }
  await render();
  return {
    reads, applied, render,
    hold() { const gate = deferred(); responses.push(gate.promise); return gate; },
    async signal(count = 1) {
      await act(async () => { for (let index = 0; index < count; index++) void notify(); await settle(); });
    },
    async release(gate, value) { await act(async () => { gate.resolve(value); await settle(); await settle(); }); },
    async close() { await act(async () => { root.unmount(); await settle(); }); assert.equal(stopped, true); container.remove(); },
  };
}

test("resource bursts wait for drafts or queued tasks to clear, then perform one refresh", async () => {
  const h = await fixture(true);
  try {
    assert.equal(h.reads.length, 0);
    await h.signal(3);
    assert.equal(h.reads.length, 0, "no read can replace an open draft or task queue");
    await h.render({ blocked: false });
    assert.deepEqual(h.reads, ["first"]);
    assert.deepEqual(h.applied, ["first"]);
  } finally { await h.close(); }
});

test("starting an edit during a refresh rejects the stale response and defers a fresh read", async () => {
  const h = await fixture();
  try {
    const gate = h.hold();
    await h.signal();
    await h.render({ blocked: true });
    await h.release(gate, "stale server value");
    assert.equal(h.applied.length, 0, "a response must not reset the newly opened draft");
    assert.equal(h.reads.length, 1);
    await h.render({ blocked: false });
    assert.deepEqual(h.reads, ["first", "first"]);
    assert.deepEqual(h.applied, ["first"]);
  } finally { await h.close(); }
});

test("selection changes and unmount invalidate in-flight reads without losing later resource events", async () => {
  const h = await fixture();
  const gate = h.hold();
  await h.signal();
  await h.signal(2);
  await h.render({ context: "second" });
  await h.release(gate, "old selection");
  assert.deepEqual(h.reads, ["first", "second"]);
  assert.deepEqual(h.applied, ["second"]);
  const last = h.hold();
  await h.signal();
  await h.close();
  await h.release(last, "closed window");
  assert.deepEqual(h.applied, ["second"]);
});
