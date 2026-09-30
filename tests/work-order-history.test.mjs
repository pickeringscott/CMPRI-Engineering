import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workOrderHistoryAction as workOrderHistoryText, workOrderHistoryText as historyLine } from '../src/lib/work-order-history.ts';

test('ticket history text describes claims, assignments, and status changes', () => {
  assert.equal(workOrderHistoryText({ event_type: 'claimed', changed_fields: { technician_name: 'Ana Ruiz' } }), 'Claimed by Ana Ruiz');
  assert.equal(workOrderHistoryText({ event_type: 'assigned', changed_fields: { technician_name: 'Ana', previous_technician_name: '' } }), 'Assigned to Ana');
  assert.equal(workOrderHistoryText({ event_type: 'assigned', changed_fields: { technician_name: 'Ana', previous_technician_name: 'Bo' } }), 'Reassigned from Bo to Ana');
  assert.equal(workOrderHistoryText({ event_type: 'unassigned', changed_fields: { technician_name: '', previous_technician_name: 'Bo' } }), 'Unassigned from Bo');
  assert.equal(workOrderHistoryText({ event_type: 'status_changed', old_status: 'Open', new_status: 'In Progress' }), 'Status Open → In Progress');
  assert.equal(workOrderHistoryText({ event_type: 'closed', old_status: 'In Progress', new_status: 'Closed' }), 'Closed (Status In Progress → Closed)');
  assert.equal(workOrderHistoryText({ event_type: 'reopened', old_status: 'Closed', new_status: 'Open' }), 'Reopened (Status Closed → Open)');
  assert.equal(workOrderHistoryText({ event_type: 'created' }), 'Work order created');
  const line = historyLine({ event_type: 'status_changed', old_status: 'Open', new_status: 'On Hold', source: 'ChatGPT' }, '2026-05-01T15:42:00Z');
  assert.match(line, /^Status Open \u2192 On Hold \u00b7 .*\d{1,2}:\d{2}.* \u00b7 via ChatGPT$/);
});

test('history migration is trigger-written, read-only to the API, and credits the real actor', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20260930200000_cmpri_work_order_history.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists public\.cmpri_work_order_history/);
  assert.match(sql, /grant select on table public\.cmpri_work_order_history to service_role/);
  assert.doesNotMatch(sql, /grant (all|insert|update|delete)[^;]*cmpri_work_order_history/i);
  assert.match(sql, /after insert or update of status, technician_name on public\.work_orders/);
  assert.match(sql, /v_actor uuid := auth\.uid\(\)/);
  assert.match(sql, /new\.history_actor_user_id := null/);
  assert.match(sql, /source text not null default ''/);
  assert.match(sql, /'Direct database change'/);

  const route = readFileSync(new URL('../src/app/api/work-orders/[id]/route.ts', import.meta.url), 'utf8');
  assert.match(route, /history_actor_user_id: auth\.principal\.identity\.id, history_source: isMcpRequest\(request\) \? "ChatGPT" : "CMPRI app"/);

  const page = readFileSync(new URL('../src/app/work-orders/[id]/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /workOrderHistoryText\(event, event\.recorded_at\)/);
  assert.match(page, /!authoritativeHistory\.some\(\(event\) => event\.event_type === "created"\)/);
});
