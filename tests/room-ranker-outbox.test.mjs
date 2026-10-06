import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const sql = readFileSync(new URL("../supabase/cmpri_v1_0_room_ranker_sync.sql", import.meta.url), "utf8");
const hotel = "00000000-0000-0000-0000-000000000001";
const order = "00000000-0000-0000-0000-000000000002";

test("Room Ranker outbox installs idempotently and queues committed work-order changes", async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`
      create table public.hotels (id uuid primary key);
      create table public.work_orders (
        id uuid primary key, hotel_id uuid not null references public.hotels(id),
        room text, issue text, status text, display_id text, notes text
      );
      insert into public.hotels (id) values ('${hotel}');
    `);
    await db.exec(sql);
    await db.exec(sql);
    const { rows: triggers } = await db.query(`
      select tgname from pg_trigger
      where tgrelid = 'public.work_orders'::regclass and not tgisinternal
    `);
    assert.deepEqual(triggers.map((row) => row.tgname), ["cmpri_room_ranker_sync_enqueue"]);
    const { rows: security } = await db.query(`
      select relrowsecurity from pg_class
      where oid = 'public.cmpri_room_ranker_sync_queue'::regclass
    `);
    assert.equal(security[0].relrowsecurity, true);
    await db.query(`
      insert into public.work_orders (id, hotel_id, room, issue, status, display_id)
      values ($1, $2, 'Synthetic non-guest location', 'Synthetic check', 'Open', 'TEST')
    `, [order, hotel]);
    let result = await db.query("select * from public.cmpri_room_ranker_sync_queue");
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].work_order_id, order);
    assert.equal(result.rows[0].hotel_id, hotel);
    assert.equal(result.rows[0].attempts, 0);
    const queueId = result.rows[0].id;
    await db.query(`
      update public.cmpri_room_ranker_sync_queue
      set attempts = 3, processed_at = now(), last_error = 'Synthetic failure'
      where id = $1
    `, [queueId]);
    await db.query("update public.work_orders set notes = 'Note only' where id = $1", [order]);
    result = await db.query("select * from public.cmpri_room_ranker_sync_queue");
    assert.equal(result.rows[0].attempts, 3);
    assert.equal(result.rows[0].last_error, "Synthetic failure");
    await db.query("update public.work_orders set status = 'Closed' where id = $1", [order]);
    result = await db.query("select * from public.cmpri_room_ranker_sync_queue");
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].id, queueId);
    assert.equal(result.rows[0].attempts, 0);
    assert.equal(result.rows[0].processed_at, null);
    assert.equal(result.rows[0].last_error, null);
    await db.query("delete from public.work_orders where id = $1", [order]);
    result = await db.query("select * from public.cmpri_room_ranker_sync_queue");
    assert.equal(result.rows.length, 0);
  } finally {
    await db.close();
  }
});

test("release schema gate requires every Room Ranker outbox column", () => {
  const source = readFileSync(new URL("../scripts/check-release-schema.mjs", import.meta.url), "utf8");
  const entry = source.match(/cmpri_room_ranker_sync_queue:\s*\[([^\]]+)\]/);
  assert(entry, "The release gate must reject a missing Room Ranker outbox.");
  for (const column of [
    "id", "hotel_id", "work_order_id", "attempts", "next_attempt_at",
    "processed_at", "last_error", "created_at", "updated_at",
  ]) {
    assert(entry[1].includes(`'${column}'`), `Missing outbox column ${column}`);
  }
});
