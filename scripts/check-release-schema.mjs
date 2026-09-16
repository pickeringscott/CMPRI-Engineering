#!/usr/bin/env node
// Read-only release gate. Never prints configuration values or database rows.
const required = {
  pool_daily_logs: ['id', 'revision', 'updated_by', 'ph_am', 'ph_pm', 'sanitizer_am', 'sanitizer_pm'],
  cmpri_pool_log_history: ['id', 'pool_log_id', 'snapshot'],
  work_orders: [
    'id', 'hotel_id', 'status', 'submitted_by_name', 'submitted_by_user_id',
    'creator_account_user_id', 'revision', 'reporter_notes', 'source_draft_id',
    'source_draft_created_by', 'source_draft_creator_name',
  ],
  cmpri_work_order_drafts: [
    'id', 'hotel_id', 'created_by', 'location_id', 'issue', 'notes',
    'revision', 'created_at', 'updated_at',
  ],
  profiles: ['id', 'role', 'active'],
  hotel_members: ['hotel_id', 'user_id', 'role', 'active'],
  cmpri_email_events: ['id', 'hotel_id'],
  cmpri_purchases: ['id', 'hotel_id'],
  cmpri_purchase_shipments: ['id', 'purchase_id'],
  cmpri_enseo_tickets: ['id', 'hotel_id'],
  cmpri_warranty_cases: ['id', 'hotel_id'],
  cmpri_supplier_followups: ['id', 'hotel_id'],
  cmpri_gss_reports: ['id', 'hotel_id'],
};
try {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase configuration is required for the read-only schema check.');
  const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/openapi+json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Schema read failed (HTTP ${response.status}).`);
  const schema = await response.json();
  const missing = [];
  for (const [table, fields] of Object.entries(required)) {
    const definition = schema.definitions?.[table];
    if (!definition) { missing.push(`Table: ${table}`); continue; }
    for (const field of fields) if (!definition.properties?.[field]) missing.push(`Column: ${table}.${field}`);
  }
  const statuses = schema.definitions?.work_orders?.properties?.status?.enum;
  if (Array.isArray(statuses)) for (const status of ['Open', 'Pending Verification', 'In Progress', 'Completed', 'Closed', 'Will Not Do']) {
    if (!statuses.includes(status)) missing.push(`Work-order status: ${status}`);
  }
  console.log(JSON.stringify({
    check: 'read-only schema contract',
    passed: missing.length === 0,
    missing,
    limitation: 'This does not verify RLS, triggers, indexes, credentials for users, or business workflows.',
  }, null, 2));
  process.exitCode = missing.length ? 1 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
