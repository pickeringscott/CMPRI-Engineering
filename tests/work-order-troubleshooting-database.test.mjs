import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {parseTicketHistory} from '../src/lib/ticket-note-presentation.ts';

const migrationsDirectory = new URL('../supabase/migrations/', import.meta.url);
const matchingMigrations = readdirSync(migrationsDirectory).filter(name => /^\d{14}_work_order_troubleshooting_checklist\.sql$/.test(name));
assert.equal(matchingMigrations.length, 1, 'Use the single recorded troubleshooting migration.');
const migration = readFileSync(new URL(matchingMigrations[0], migrationsDirectory), 'utf8');
const hotel = '00000000-0000-4000-8000-000000000001';
const otherHotel = '00000000-0000-4000-8000-000000000002';
const actor = '00000000-0000-4000-8000-000000000003';
const ticket = '00000000-0000-4000-8000-000000000004';
const assetId = '00000000-0000-4000-8000-000000000005';
const otherTicket = '00000000-0000-4000-8000-000000000006';
const context = 'a'.repeat(64);
const visitId = '00000000-0000-4000-8000-000000000007';
const asset = {
  id: assetId, manufacturer: 'ACME', model_family: 'Cooling', model_number: 'A1',
  documentation_key: 'reviewed-manual', documentation_revision_id: null,
  documentation_verified_at: '2026-11-08T12:00:00Z', pdf_import_links: null,
};

async function fixture() {
  const db = new PGlite();
  await db.exec(`set time zone 'UTC';
    create role authenticated; create role anon; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated,anon,service_role;
    grant execute on function auth.uid() to authenticated,anon,service_role;
    create table profiles(id uuid primary key, active boolean, full_name text default 'Test Technician', role text default 'technician');
    create table hotel_members(user_id uuid,hotel_id uuid,active boolean);
    create table assets(id uuid primary key,hotel_id uuid,manufacturer text,model_family text,model_number text,
      documentation_key text,documentation_revision_id uuid,documentation_verified_at timestamptz,pdf_import_links jsonb);
    create table work_orders(id uuid primary key,hotel_id uuid,asset_id uuid references assets(id),revision bigint,status text,
      notes text default '',history_actor_user_id uuid,history_source text);
    create table pm_entries(id int primary key,completed boolean);
    insert into profiles(id,active) values ('${actor}',true);
    insert into hotel_members values ('${actor}','${hotel}',true);
    insert into hotel_members values ('${actor}','${otherHotel}',true);
    insert into assets values ('${assetId}','${hotel}','ACME','Cooling','A1','reviewed-manual',null,'2026-11-08T12:00:00Z',null);
    insert into work_orders(id,hotel_id,asset_id,revision,status) values ('${ticket}','${hotel}','${assetId}',1,'In Progress'),('${otherTicket}','${otherHotel}',null,1,'Open');
    insert into pm_entries values (1,false);
    grant select on profiles,hotel_members,assets,work_orders to service_role;
    grant update on assets,work_orders to service_role;
    grant select on work_orders to authenticated;
    alter table work_orders enable row level security;
    create schema cmpri_private;
    create table signal_events(topic text);
    create function cmpri_private.signal_resource() returns trigger language plpgsql security definer set search_path='' as $$
      begin insert into public.signal_events values(TG_ARGV[0]); return null; end;
    $$;
    create table note_events(actor_id uuid,source text,notes text);
    create function record_note_event() returns trigger language plpgsql security definer set search_path='' as $$
      begin
        if new.notes is distinct from old.notes then
          insert into public.note_events values(nullif(current_setting('cmpri.history_actor',true),'')::uuid,current_setting('cmpri.history_source',true),new.notes);
        end if;
        return null;
      end;
    $$;
    create trigger note_event after update of notes on work_orders for each row execute function record_note_event();`);
  const membership = readFileSync(new URL('../supabase/migrations/20261002214500_cmpri_rls_least_privilege.sql', import.meta.url), 'utf8');
  await db.exec(membership.slice(0, membership.indexOf('CREATE OR REPLACE FUNCTION public.can_manage_hotel')));
  await db.exec(`create policy work_orders_member_select on work_orders for select to authenticated using(public.is_hotel_member(hotel_id));`);
  await db.exec(readFileSync(new URL('../supabase/cmpri_v1_0_work_order_revision.sql', import.meta.url), 'utf8'));
  const history = readFileSync(new URL('../supabase/migrations/20260930200000_cmpri_work_order_history.sql', import.meta.url), 'utf8');
  await db.exec(history.slice(history.indexOf('create or replace function public.cmpri_capture_work_order_history_actor()'), history.indexOf('create or replace function public.cmpri_log_work_order_history()')));
  await db.exec(migration);
  await db.exec('alter table assets add column serial_number text');
  await db.exec(readFileSync(new URL('../supabase/migrations/20261112065852_troubleshooting_serial_guard.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../supabase/migrations/20261113001000_troubleshooting_note_worker_attribution.sql', import.meta.url), 'utf8'));
  async function as(role, fn) {
    await db.exec(`set role ${role}`);
    try { return await fn(); } finally { await db.exec('reset role'); }
  }
  async function save(overrides = {}) {
    const input = {hotel, ticket, context, expected: 0, ticketRevision: 1, asset, states: {'step-1': {status: 'needs', workerId: actor, workerName: 'Tech', workerChecked: true}}, actor,
      visit: visitId, mutation: randomUUID(), item: 'step-1', action: 'toggle', label: 'Inspect filter.',
      source: {title: 'Service manual', storage_path: 'manual.pdf', sha256: 'a'.repeat(64)}, ...overrides};
    const current = (await db.query('select task_states from cmpri_work_order_troubleshooting_checks where hotel_id=$1 and work_order_id=$2 and context_key=$3', [input.hotel,input.ticket,input.context])).rows[0];
    const before = Object.hasOwn(overrides, 'before') ? overrides.before : current?.task_states?.[input.item] ?? null;
    const after = Object.hasOwn(overrides, 'after') ? overrides.after : input.states?.[input.item] ?? null;
    return as('service_role', async () => (await db.query(
      'select * from public.cmpri_save_work_order_troubleshooting($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb)',
      [input.hotel,input.ticket,input.context,input.expected,input.ticketRevision,JSON.stringify(input.asset),JSON.stringify(input.states),input.actor,input.visit,input.mutation,input.item,input.action,input.label,JSON.stringify(input.source),JSON.stringify(before),JSON.stringify(after)],
    )).rows);
  }
  async function finalize(overrides = {}) {
    const input = {hotel, ticket, visit: visitId, actor, ...overrides};
    return as('service_role', async () => (await db.query('select public.cmpri_finalize_work_order_troubleshooting($1,$2,$3,$4) as result', [input.hotel,input.ticket,input.visit,input.actor])).rows[0].result);
  }
  return {db, as, save, finalize};
}

test('checklist saves reject a changed asset serial while older clients remain compatible', async () => {
  const {db, save} = await fixture();
  try {
    await db.exec(`update assets set serial_number='200' where id='${assetId}'`);
    await assert.rejects(save({asset: {...asset, serial_number:'150'}}), error => error.code === '40001');
    const [saved] = await save({asset: {...asset, serial_number:'200'}});
    assert.equal(Number(saved.revision), 1);
  } finally { await db.close(); }
  const older = await fixture();
  try {
    await older.db.exec(`update assets set serial_number='200' where id='${assetId}'`);
    assert.equal((await older.save()).length, 1);
  } finally { await older.db.close(); }
});

test('ledger RPC uses independent revisions and atomically rejects stale updates without changing tickets or PM', async () => {
  const {db, save} = await fixture();
  try {
    const beforeTickets = (await db.query('select * from work_orders order by id')).rows;
    const beforePm = (await db.query('select * from pm_entries')).rows;
    const [initial] = await save();
    assert.equal(Number(initial.revision), 1);
    assert.deepEqual(initial.task_states, {'step-1': {status: 'needs', workerId: actor, workerName: 'Tech', workerChecked: true}});
    const states = {'step-1': {status: 'approved', workerId: actor, workerName: 'Tech', workerChecked: true, reviewedBy: 'Chief'}};
    const [updated] = await save({expected: 1, states});
    assert.equal(Number(updated.revision), 2);
    await assert.rejects(save({expected: 1}), error => error.code === '40001');
    await assert.rejects(save({expected: 0}), error => error.code === '23505');
    assert.deepEqual((await db.query('select * from work_orders order by id')).rows, beforeTickets);
    assert.deepEqual((await db.query('select * from pm_entries')).rows, beforePm);
    const row = (await db.query('select * from cmpri_work_order_troubleshooting_checks')).rows[0];
    assert.equal(Number(row.revision), 2);
    assert.deepEqual(row.task_states, states);
    assert.equal(row.updated_by, actor);
    assert.deepEqual((await db.query('select * from signal_events')).rows, [{topic: 'orders'}, {topic: 'orders'}]);
  } finally { await db.close(); }
});

test('authenticated ledger reads require readable tickets and active profile/property membership; no client writes or RPC', async () => {
  const {db, as, save} = await fixture();
  try {
    await save();
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
    const visible = () => as('authenticated', async () => (await db.query('select * from cmpri_work_order_troubleshooting_checks')).rows);
    assert.equal((await visible()).length, 1);
    await db.exec('update profiles set active=false'); assert.equal((await visible()).length, 0);
    await db.exec('update profiles set active=true; update hotel_members set active=false'); assert.equal((await visible()).length, 0);
    await db.exec('update hotel_members set active=true');
    await db.exec('drop policy work_orders_member_select on work_orders'); assert.equal((await visible()).length, 0);
    for (const sql of [
      `insert into cmpri_work_order_troubleshooting_checks(hotel_id,work_order_id,context_key,updated_by) values('${hotel}','${ticket}','${'b'.repeat(64)}','${actor}')`,
      'update cmpri_work_order_troubleshooting_checks set revision=99',
      'delete from cmpri_work_order_troubleshooting_checks',
      'truncate cmpri_work_order_troubleshooting_checks',
      `select * from cmpri_save_work_order_troubleshooting('${hotel}','${ticket}','${context}',1,1,null,'{}','${actor}','${visitId}','${randomUUID()}','step-1','toggle','Label','{}',null,'{}')`,
      `select cmpri_finalize_work_order_troubleshooting('${hotel}','${ticket}','${visitId}','${actor}')`,
    ]) await assert.rejects(as('authenticated', () => db.exec(sql)), /permission denied/);
    await assert.rejects(as('anon', () => db.exec('select * from cmpri_work_order_troubleshooting_checks')), /permission denied/);
  } finally { await db.close(); }
});

test('RPC rejects stale ticket revisions, wrong property, inactive actor and wrong-property ledger foreign keys', async () => {
  const {db, as, save} = await fixture();
  try {
    await assert.rejects(save({hotel: otherHotel}), error => error.code === '40001');
    await db.exec('update work_orders set revision=2');
    await assert.rejects(save(), error => error.code === '40001');
    await db.exec('update profiles set active=false');
    await assert.rejects(save({ticketRevision: 2}), error => error.code === '42501');
    await db.exec('update profiles set active=true; update hotel_members set active=false');
    await assert.rejects(save({ticketRevision: 2}), error => error.code === '42501');
    await assert.rejects(as('service_role', () => db.query(
      'insert into cmpri_work_order_troubleshooting_checks(hotel_id,work_order_id,context_key,updated_by) values($1,$2,$3,$4)',
      [otherHotel, ticket, context, actor],
    )), error => error.code === '23503');
    assert.equal((await db.query('select count(*)::int as n from cmpri_work_order_troubleshooting_checks')).rows[0].n, 0);
  } finally { await db.close(); }
});

test('asset association, model, and document changes reject stale contexts; equivalent timestamp notation is accepted', async () => {
  const {db, save} = await fixture();
  try {
    const fields = {
      manufacturer: 'Other', model_family: 'Other family', model_number: 'A2', documentation_key: 'new-manual',
      documentation_revision_id: '00000000-0000-4000-8000-000000000099',
      documentation_verified_at: '2026-11-08T13:00:00Z', pdf_import_links: [{key: 'new.pdf'}],
    };
    for (const [field, value] of Object.entries(fields)) {
      const stale = {...asset, [field]: value};
      await assert.rejects(save({asset: stale}), error => error.code === '40001', field);
    }
    const [row] = await save({asset: {...asset, documentation_verified_at: '2026-11-08T12:00:00+00:00'}});
    assert.equal(Number(row.revision), 1);
    // Registration updates the authoritative asset projection's PDF links even
    // when the documentation revision and verification timestamp stay unchanged.
    await db.query('update assets set pdf_import_links=$1::jsonb where id=$2', [JSON.stringify([{storage_path: 'new-manual.pdf', preferred: true}]), assetId]);
    await assert.rejects(save({expected: 1}), error => error.code === '40001');
    assert.equal(Number((await db.query('select revision from cmpri_work_order_troubleshooting_checks')).rows[0].revision), 1);
    await db.exec(`update assets set pdf_import_links=null where id='${assetId}'`);
    await db.exec(`update work_orders set asset_id=null where id='${ticket}'`);
    await assert.rejects(save({expected: 1}), error => error.code === '40001');
    const [unlinked] = await save({expected: 0, context: 'b'.repeat(64), asset: null, ticketRevision: 2});
    assert.equal(Number(unlinked.revision), 1);
  } finally { await db.close(); }
});

test('RPC rejects malformed task/context payloads before writing', async () => {
  const {db, save} = await fixture();
  try {
    for (const input of [
      {context: 'not-a-context'}, {expected: -1}, {states: []}, {states: {'step:one': 'checked'}},
      {states: {'step:one': {status: 'unknown'}}}, {states: {'step:one': {status: 'needs', workerId: 'not-uuid'}}},
      {states: {'step:one': {status: 'needs', workerChecked: 'true'}}},
      {states: {'step:one': {status: 'needs', workerName: false}}}, {states: {'step:one': {status: 'approved', reviewedBy: []}}},
      {states: {'': {status: 'empty'}}}, {states: {['x'.repeat(513)]: {status: 'empty'}}},
      {states: Object.fromEntries(Array.from({length: 251}, (_, i) => [`step:${i}`, {status: 'empty'}]))},
    ]) await assert.rejects(save(input), error => error.code === '22023');
    assert.equal((await db.query('select count(*)::int as n from cmpri_work_order_troubleshooting_checks')).rows[0].n, 0);
  } finally { await db.close(); }
});

test('visit journal retains every check and clear across contexts and appends one normal note to current ticket history on exit', async () => {
  const {db, save, finalize} = await fixture();
  try {
    await db.exec(`update work_orders set notes='Existing note' where id='${ticket}'`);
    const firstMutation = randomUUID();
    await save({ticketRevision: 2, mutation: firstMutation, before: null});
    await save({ticketRevision: 2, expected: 1, action: 'clear', states: {'step-1': {status: 'empty'}}});
    await save({ticketRevision: 2, context: 'b'.repeat(64), label: 'Inspect second manual action.', source: {title: 'Second service manual', storage_path: 'second.pdf', source_pages: [7]}});
    const events = (await db.query('select * from cmpri_work_order_troubleshooting_events order by event_number')).rows;
    assert.equal(events.length, 3); assert.equal(events[0].after_state.workerChecked, true);
    assert.deepEqual(events[1].after_state, {status: 'empty'}); assert.equal(events[1].before_state.workerId, actor);
    assert.equal(events[2].context_key, 'b'.repeat(64));
    const pending = (await db.query('select * from cmpri_work_order_troubleshooting_visits where finalized_at is null')).rows;
    assert.equal(pending.length, 1); assert.equal(pending[0].event_count, 3); assert.ok(pending[0].last_event_at);
    assert.equal(Number((await db.query('select revision from work_orders where id=$1', [ticket])).rows[0].revision), 2);
    await db.exec(`update work_orders set notes=notes||E'\nConcurrent collaborator note' where id='${ticket}'`);
    const finalized = await finalize();
    assert.equal(finalized.finalized, true); assert.equal(finalized.already_finalized, false);
    assert.equal(finalized.event_count, 3); assert.equal(Number(finalized.work_order_revision), 4);
    const row = (await db.query('select * from work_orders where id=$1', [ticket])).rows[0];
    assert.match(row.notes, /^Existing note\nConcurrent collaborator note\nCMPRI2\|/);
    const notes = parseTicketHistory(row.notes).filter(note => note.actor === 'Test Technician');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].text, 'Troubleshooting: Inspect filter — checked → cleared; Inspect second manual action — checked. Sources: manual.pdf; second.pdf.');
    assert.equal((notes[0].text.match(/Inspect filter/g) || []).length, 1);
    assert.equal((notes[0].text.match(/Inspect second manual action/g) || []).length, 1);
    assert.doesNotMatch(notes[0].text, /\(p\.|\(pp\.|\[1\]|\[2\]/);
    assert.equal((notes[0].text.match(/manual\.pdf/g) || []).length, 1);
    assert.equal((notes[0].text.match(/second\.pdf/g) || []).length, 1);
    assert.doesNotMatch(notes[0].text, /Test Technician|\d{4}-\d{2}-\d{2}T|\(technician\)/);
    assert.equal((finalized.note.match(/Test Technician/g) || []).length, 1, 'actor appears once in the normal note header');
    assert.doesNotMatch(notes[0].text, /context [a-f0-9]{64}|"workerId"|"sha256"/);
    assert.equal(row.status, 'In Progress'); assert.equal(row.history_actor_user_id, null); assert.equal(row.history_source, null);
    assert.equal((await db.query('select completed from pm_entries')).rows[0].completed, false);
    const noteEvent = (await db.query('select * from note_events')).rows.at(-1);
    assert.equal(noteEvent.actor_id, actor); assert.equal(noteEvent.source, 'CMPRI troubleshooting checklist');
    const countBefore = (await db.query('select count(*)::int as n from note_events')).rows[0].n;
    const repeated = await finalize(); assert.equal(repeated.already_finalized, true);
    assert.equal((await db.query('select count(*)::int as n from note_events')).rows[0].n, countBefore);
    // A lost checkbox response can be acknowledged after finalization without a second action or note.
    const replay = await save({ticketRevision: 2, mutation: firstMutation, before: null});
    assert.equal(Number(replay[0].revision), 2); assert.deepEqual(replay[0].task_states['step-1'], {status: 'empty'});
    await assert.rejects(save({ticketRevision: 2, mutation: firstMutation, before: null, label: 'Different replay'}), error => error.code === '40001');
    await assert.rejects(save({ticketRevision: 4, expected: 2}), error => error.code === '40001');
    assert.equal((await db.query('select count(*)::int as n from cmpri_work_order_troubleshooting_events')).rows[0].n, 3);
  } finally { await db.close(); }
});

test('empty visit finalization closes the visit before a delayed first checkbox save and never adds an empty note', async () => {
  const {db, save, finalize} = await fixture();
  try {
    const empty = await finalize(); assert.equal(empty.finalized, true); assert.equal(empty.event_count, 0); assert.equal(empty.note, null);
    assert.equal(Number(empty.work_order_revision), 1);
    await assert.rejects(save(), error => error.code === '40001');
    assert.equal((await db.query('select count(*)::int as n from cmpri_work_order_troubleshooting_checks')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from cmpri_work_order_troubleshooting_events')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from note_events')).rows[0].n, 0);
    assert.equal((await finalize()).already_finalized, true);
  } finally { await db.close(); }
});

test('ledger and journal writes roll back together if journal persistence fails', async () => {
  const {db, save} = await fixture();
  try {
    await db.exec(`create function fail_journal() returns trigger language plpgsql as $$begin raise exception 'Synthetic journal failure'; end$$;
      create trigger fail_journal before insert on cmpri_work_order_troubleshooting_events for each row execute function fail_journal();`);
    await assert.rejects(save(), /Synthetic journal failure/);
    for (const table of ['cmpri_work_order_troubleshooting_checks', 'cmpri_work_order_troubleshooting_events', 'cmpri_work_order_troubleshooting_visits', 'signal_events']) {
      assert.equal((await db.query(`select count(*)::int as n from ${table}`)).rows[0].n, 0, table);
    }
    await db.exec('drop trigger fail_journal on cmpri_work_order_troubleshooting_events');
    assert.equal(Number((await save())[0].revision), 1);
  } finally { await db.close(); }
});

test('failed exit keeps pending journal recoverable and retries append exactly once after the actor role changes', async () => {
  const {db, save, finalize} = await fixture();
  try {
    await save();
    await db.exec(`create function fail_exit_note() returns trigger language plpgsql as $$begin raise exception 'Synthetic note failure'; end$$;
      create trigger fail_exit_note before update of notes on work_orders for each row execute function fail_exit_note();`);
    await assert.rejects(finalize(), /Synthetic note failure/);
    assert.equal((await db.query('select finalized_at from cmpri_work_order_troubleshooting_visits')).rows[0].finalized_at, null);
    assert.equal(Number((await db.query('select revision from work_orders where id=$1', [ticket])).rows[0].revision), 1);
    assert.equal((await db.query('select count(*)::int as n from cmpri_work_order_troubleshooting_events')).rows[0].n, 1);
    await db.exec(`drop trigger fail_exit_note on work_orders; update profiles set role='manager',full_name=E'Renamed | Staff\nPerson';`);
    const result = await finalize(); assert.equal(Number(result.work_order_revision), 2);
    const parsed = parseTicketHistory(result.note); assert.equal(parsed.length, 1); assert.equal(parsed[0].kind, 'note');
    assert.doesNotMatch(parsed[0].actor, /\n|\|/);
    assert.equal(parsed[0].text, 'Troubleshooting: Inspect filter — checked. Source: manual.pdf.');
    assert.doesNotMatch(parsed[0].text, /Test Technician|Renamed|\d{4}-\d{2}-\d{2}T/);
    const event = (await db.query('select actor_name,actor_role,recorded_at,source from cmpri_work_order_troubleshooting_events')).rows[0];
    assert.equal(event.actor_name, 'Test Technician'); assert.equal(event.actor_role, 'technician'); assert.ok(event.recorded_at);
    assert.equal(event.source.sha256, 'a'.repeat(64));
    assert.equal((await finalize()).already_finalized, true);
    assert.equal((await db.query('select count(*)::int as n from note_events')).rows[0].n, 1);
  } finally { await db.close(); }
});

test('visit journal access is scoped to actor, property and ticket and client mutations remain denied', async () => {
  const {db, as, save, finalize} = await fixture();
  try {
    await save();
    const otherActor = '00000000-0000-4000-8000-000000000099';
    await db.query('insert into profiles(id,active) values($1,true)', [otherActor]);
    await db.query('insert into hotel_members values($1,$2,true)', [otherActor, hotel]);
    for (const table of ['cmpri_work_order_troubleshooting_visits', 'cmpri_work_order_troubleshooting_events']) {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
      assert.equal((await as('authenticated', () => db.query(`select * from ${table}`))).rows.length, 1);
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [otherActor]);
      assert.equal((await as('authenticated', () => db.query(`select * from ${table}`))).rows.length, 0);
      for (const sql of [`delete from ${table}`, `truncate ${table}`]) await assert.rejects(as('authenticated', () => db.exec(sql)), /permission denied/);
      await assert.rejects(as('anon', () => db.exec(`select * from ${table}`)), /permission denied/);
    }
    await assert.rejects(finalize({actor: otherActor}), error => error.code === '42501');
    await assert.rejects(finalize({hotel: otherHotel, ticket: otherTicket}), error => error.code === '42501');
    await assert.rejects(save({actor: otherActor, expected: 1}), error => error.code === '40001');
    assert.equal((await db.query('select finalized_at from cmpri_work_order_troubleshooting_visits')).rows[0].finalized_at, null);
  } finally { await db.close(); }
});

test('one mutation cannot silently overwrite other steps outside its journal event', async () => {
  const {db, save} = await fixture();
  try {
    await save();
    await assert.rejects(save({expected: 1, item: 'step-2', states: {'step-1': {status: 'empty'}, 'step-2': {status: 'needs', workerId: actor}}}), error => error.code === '40001');
    assert.equal((await db.query('select count(*)::int as n from cmpri_work_order_troubleshooting_events')).rows[0].n, 1);
    assert.equal(Number((await db.query('select revision from cmpri_work_order_troubleshooting_checks')).rows[0].revision), 1);
  } finally { await db.close(); }
});

test('exit note distinguishes Chief direct completion from verification of a technician completion', async () => {
  const {db, save, finalize} = await fixture();
  try {
    const worker = '00000000-0000-4000-8000-000000000098';
    await db.exec(`update profiles set role='chief_engineer',full_name='Chief Reviewer' where id='${actor}'`);
    await db.query('insert into profiles(id,active,full_name,role) values($1,true,$2,$3)', [worker, 'Technician Worker', 'technician']);
    await db.query('insert into hotel_members values($1,$2,true)', [worker, hotel]);
    await save({states: {'step-1': {status: 'approved', workerId: actor, workerName: 'Chief Reviewer', workerChecked: true, reviewedBy: 'Chief Reviewer'}}, label: 'Complete filter inspection.'});
    const techState = {status: 'needs', workerId: worker, workerName: 'Technician Worker', workerChecked: true};
    await save({actor: worker, visit: randomUUID(), context: 'b'.repeat(64), states: {'step-1': techState}, label: 'Inspect cooling demand.'});
    await save({context: 'b'.repeat(64), expected: 1, states: {'step-1': {...techState, status: 'approved', reviewedBy: 'Chief Reviewer'}}, label: 'Inspect cooling demand.'});
    const result = await finalize();
    const [note] = parseTicketHistory(result.note);
    assert.match(note.text, /Complete filter inspection — completed and verified;/);
    assert.match(note.text, /Inspect cooling demand — verified \(completed by Technician Worker\)\./);
    assert.equal(note.actor, 'Chief Reviewer');
    assert.equal((note.text.match(/completed and verified/g) || []).length, 1);
    assert.equal(result.event_count, 2, 'Chief visit retains its direct completion and separate review');
    const reviewEvent = (await db.query('select before_state,after_state from cmpri_work_order_troubleshooting_events where actor_id=$1 order by event_number desc limit 1', [actor])).rows[0];
    assert.equal(reviewEvent.before_state.workerId, worker); assert.equal(reviewEvent.after_state.workerId, worker);
  } finally { await db.close(); }
});

test('compact exit note keeps the complete check verify clear cycle with one actor header and one common PDF reference', async () => {
  const {db, save, finalize} = await fixture();
  try {
    await db.exec(`update profiles set role='chief_engineer',full_name='Chief Reviewer' where id='${actor}'`);
    const source = {source_file_name: 'manual.pdf', storage_path: `${hotel}/${assetId}/123-manual.pdf`, sha256: 'f'.repeat(64), registered_file_id: 'registered-manual', source_pages: [4]};
    const checked = {status: 'needs', workerId: actor, workerName: 'Chief Reviewer', workerChecked: true};
    await save({source, states: {'step-1': checked}});
    await save({source, expected: 1, states: {'step-1': {...checked, status: 'approved', reviewedBy: 'Chief Reviewer'}}});
    await save({source, expected: 2, action: 'clear', states: {'step-1': {status: 'empty'}}});
    const result = await finalize();
    const parsed = parseTicketHistory(result.note);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].text, 'Troubleshooting: Inspect filter — checked → verified → cleared. Source: manual.pdf.');
    assert.equal((parsed[0].text.match(/Inspect filter/g) || []).length, 1);
    assert.doesNotMatch(parsed[0].text, /\(p\.|\(pp\.|\d{4}-\d{2}-\d{2}T|Chief Reviewer/);
    assert.equal((result.note.match(/Chief Reviewer/g) || []).length, 1);
    assert.equal((result.note.match(/\d{4}-\d{2}-\d{2}T/g) || []).length, 1);
    assert.equal((result.note.match(/manual\.pdf/g) || []).length, 1);
    const events = (await db.query('select * from cmpri_work_order_troubleshooting_events order by event_number')).rows;
    assert.equal(events.length, 3); assert.equal(result.event_count, 3);
    for (const event of events) {
      assert.equal(event.actor_id, actor); assert.equal(event.actor_name, 'Chief Reviewer'); assert.ok(event.recorded_at);
      assert.equal(event.source.sha256, source.sha256); assert.equal(event.source.storage_path, source.storage_path);
    }
    assert.equal(events[1].after_state.status, 'approved');
    assert.equal(events[2].before_state.status, 'approved'); assert.deepEqual(events[2].after_state, {status: 'empty'});
    assert.equal(Number((await db.query('select revision from cmpri_work_order_troubleshooting_checks')).rows[0].revision), 3);
  } finally { await db.close(); }
});

test('grouped note names each step once and preserves repeated reversals without joining independent source contexts', async () => {
  const {db, save, finalize} = await fixture();
  try {
    const checked = {status: 'needs', workerId: actor, workerName: 'Tech', workerChecked: true};
    const empty = {status: 'empty'};
    await save();
    await save({expected: 1, item: 'step-2', label: 'Inspect connector.', states: {'step-1': checked, 'step-2': checked}});
    await save({expected: 2, action: 'clear', states: {'step-1': empty, 'step-2': checked}});
    await save({expected: 3, states: {'step-1': checked, 'step-2': checked}});
    await save({expected: 4, item: 'step-2', label: 'Inspect connector.', action: 'clear', states: {'step-1': checked, 'step-2': empty}});
    const differentSource = {source_file_name: 'other.pdf', storage_path: 'different/other.pdf', sha256: 'b'.repeat(64), source_pages: [9]};
    await save({context: 'b'.repeat(64), source: differentSource});
    await save({context: 'b'.repeat(64), source: differentSource, expected: 1, action: 'clear', states: {'step-1': empty}});
    const result = await finalize(); const [note] = parseTicketHistory(result.note);
    assert.equal(note.text, 'Troubleshooting: Inspect filter — checked → cleared → checked / checked → cleared; Inspect connector — checked → cleared. Sources: manual.pdf; other.pdf.');
    for (const label of ['Inspect filter', 'Inspect connector', 'manual.pdf', 'other.pdf']) assert.equal(note.text.split(label).length - 1, 1, label);
    assert.equal((note.text.match(/checked/g) || []).length, 4); assert.equal((note.text.match(/cleared/g) || []).length, 3);
    assert.doesNotMatch(note.text, /\(p\.|\(pp\.|\[1\]|\[2\]|\d{4}-\d{2}-\d{2}T|Test Technician/);
    const events = (await db.query('select * from cmpri_work_order_troubleshooting_events order by event_number')).rows;
    assert.equal(events.length, 7); assert.equal(result.event_count, 7);
    assert.deepEqual(events.map(event => event.step_label), ['Inspect filter.', 'Inspect connector.', 'Inspect filter.', 'Inspect filter.', 'Inspect connector.', 'Inspect filter.', 'Inspect filter.']);
    assert.notEqual(events[0].context_key, events[5].context_key);
    assert.equal(events[5].source.sha256, differentSource.sha256); assert.deepEqual(events[5].source.source_pages, [9]);
  } finally { await db.close(); }
});
