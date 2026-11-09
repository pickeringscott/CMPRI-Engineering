import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

test('dashboard ranks and one-pass counts preserve status semantics and hotel scope', async () => {
  const db = new PGlite();
  try {
    await db.exec(`set time zone 'UTC';
      create role anon; create role authenticated; create role service_role;
      create type work_order_status as enum ('Open','In Progress','Completed','Done','Pending Verification','Closed','Will Not Do');
      create table work_orders (id uuid primary key, hotel_id uuid not null, status work_order_status not null,
        priority text not null, created_at timestamptz not null, due_by timestamptz);
      grant select on work_orders to service_role;
      insert into work_orders values
        ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Open','High','2026-01-01','2026-10-01'),
        ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Done','Normal','2026-03-01',null),
        ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','Pending Verification','Urgent','2026-01-01','2026-01-01'),
        ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','Completed','High','2026-04-01','2026-01-01'),
        ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000001','In Progress','Urgent','2026-01-01','2026-11-09'),
        ('00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000001','Will Not Do','High','2026-01-01',null),
        ('00000000-0000-0000-0000-000000000007','00000000-0000-0000-0000-000000000002','Open','High','2026-01-01','2026-01-01'),
        ('00000000-0000-0000-0000-000000000008','00000000-0000-0000-0000-000000000003','Open','Normal','2026-01-01 00:00:00.000100+00',null),
        ('00000000-0000-0000-0000-000000000009','00000000-0000-0000-0000-000000000003','Open','Normal','2026-01-01 00:00:00.000900+00',null);`);
    const directory = new URL('../supabase/migrations/', import.meta.url);
    const file = readdirSync(directory).find(name => /^\d{14}_work_order_dashboard_efficiency\.sql$/.test(name));
    assert.ok(file);
    await db.exec(readFileSync(new URL(file, directory), 'utf8'));
    const counts = await db.query("select public.cmpri_work_order_dashboard_counts('00000000-0000-0000-0000-000000000001', '2026-11-09') as value");
    assert.deepEqual(counts.rows[0].value, {all:6,pending:1,open:3,progress:1,priority:2,overdue:1,completed:1,closed:1});
    const sorted = await db.query("select id from work_orders where hotel_id='00000000-0000-0000-0000-000000000001' order by cmpri_dashboard_status_rank, cmpri_dashboard_created_ms desc, id limit 3 offset 2");
    assert.deepEqual(sorted.rows.map(row=>row.id.slice(-1)), ['5','4','2']);
    const tie = await db.query("select id from work_orders where hotel_id='00000000-0000-0000-0000-000000000003' order by cmpri_dashboard_status_rank, cmpri_dashboard_created_ms desc, id limit 1 offset 1");
    assert.equal(tie.rows[0].id.slice(-1), '9', 'same-millisecond timestamps use ID order even across a page boundary');
    await db.exec('set enable_seqscan=off; set enable_bitmapscan=off');
    const plan = await db.query("explain select id from work_orders where hotel_id='00000000-0000-0000-0000-000000000003' order by cmpri_dashboard_status_rank, cmpri_dashboard_created_ms desc nulls last, id limit 1");
    const planText = plan.rows.map(row=>row['QUERY PLAN']).join('\n');
    assert.match(planText, /cmpri_work_orders_dashboard_default_idx/);
    assert.doesNotMatch(planText, /Sort/);
    await db.exec('set role authenticated');
    await assert.rejects(db.query("select public.cmpri_work_order_dashboard_counts('00000000-0000-0000-0000-000000000001', '2026-11-09')"), /permission denied/);
  } finally { await db.close(); }
});
