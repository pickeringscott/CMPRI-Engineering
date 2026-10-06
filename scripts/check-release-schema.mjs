#!/usr/bin/env node
// Read-only release gate. Never prints configuration values or database rows.
const required = {
  pool_daily_logs: ['id', 'revision', 'updated_by', 'ph_am', 'ph_pm', 'sanitizer_am', 'sanitizer_pm', 'sanitizer_band_am', 'sanitizer_band_pm', 'sample_location_am', 'sample_location_pm', 'flow_rate_gpm', 'temperature_f', 'main_drain_visible', 'filter_backwashed', 'closure_condition', 'closure_reason', 'remarks'],
  cmpri_pool_log_history: ['id', 'pool_log_id', 'snapshot'],
  work_orders: [
    'id', 'hotel_id', 'status', 'submitted_by_name', 'submitted_by_user_id',
    'creator_account_user_id', 'revision', 'reporter_notes', 'source_draft_id',
    'source_draft_created_by', 'source_draft_creator_name', 'last_assigned_technician_name',
    'import_source', 'import_external_id', 'import_reported_at', 'imported_at', 'imported_by_user_id',
  ],
  cmpri_work_order_drafts: [
    'id', 'hotel_id', 'created_by', 'location_id', 'issue', 'notes',
    'revision', 'created_at', 'updated_at',
  ],
  profiles: ['id', 'role', 'active'],
  hotel_members: ['hotel_id', 'user_id', 'role', 'active'],
  role_permissions: ['role', 'permission', 'allowed'],
  cmpri_vendors: ['id', 'hotel_id', 'company_name', 'services', 'main_phone', 'active'],
  cmpri_vendor_contacts: ['id', 'hotel_id', 'vendor_id', 'name', 'role_title', 'mobile_phone', 'active'],
  cmpri_vendor_proposals: ['id', 'hotel_id', 'vendor_id', 'proposal_date', 'recommendation', 'vendor_company_snapshot', 'status'],
  cmpri_inventory_items: ['id', 'hotel_id', 'item_name', 'preferred_vendor_id', 'quantity_on_hand', 'quantity_reserved', 'active'],
  cmpri_asset_inventory_compatibility: ['hotel_id', 'asset_id', 'inventory_item_id'],
  cmpri_work_order_items: ['id', 'hotel_id', 'work_order_id', 'inventory_item_id', 'status', 'quantity', 'recorded_at'],
  cmpri_inventory_movements: ['id', 'hotel_id', 'inventory_item_id', 'movement_type', 'quantity_change'],
  cmpri_order_ideas: ['id', 'hotel_id', 'item_text', 'quantity', 'status', 'source'],
  cmpri_enseo_assignments: ['id', 'hotel_id', 'asset_id', 'device_type', 'location_id', 'room_number', 'sub_location', 'endpoint_code', 'active', 'revision'],
  cmpri_enseo_assignment_history: ['id', 'batch_id', 'hotel_id', 'assignment_id', 'asset_id', 'actor_user_id', 'from_location_id', 'to_location_id', 'moved_at'],
  cmpri_email_events: ['id', 'hotel_id'],
  cmpri_purchases: ['id', 'hotel_id'],
  cmpri_purchase_shipments: ['id', 'purchase_id'],
  cmpri_enseo_tickets: ['id', 'hotel_id'],
  cmpri_warranty_cases: ['id', 'hotel_id'],
  cmpri_supplier_followups: ['id', 'hotel_id'],
  cmpri_gss_reports: ['id', 'hotel_id'],
  cmpri_room_ranker_sync_queue: [
    'id', 'hotel_id', 'work_order_id', 'attempts', 'next_attempt_at',
    'processed_at', 'last_error', 'created_at', 'updated_at',
  ],
  cmpri_dashboard_notifications: [
    'id', 'hotel_id', 'recipient_user_id', 'notification_key', 'work_order_id',
    'target_path', 'message', 'recorded_at', 'read_at', 'cleared_at',
  ],
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
