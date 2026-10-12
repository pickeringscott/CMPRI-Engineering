// Fixture roles have no secondary roles. Keep production RLS unchanged.
export function expectedVisibleRows(role, rows) {
  if (['front_desk', 'housekeeping'].includes(role)) return [];
  if (['manager', 'assistant_manager', 'front_desk_manager'].includes(role)) {
    return rows.filter(row => ['Open', 'In Progress'].includes(row.status));
  }
  if (['technician', 'chief_engineer'].includes(role)) return rows;
  throw new Error(`Unrecognized sandbox role: ${role}`);
}

export function matchesVisibleRows(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    new Set(actual.map(row => row.id)).size === actual.length &&
    actual.every(row => expected.some(wanted => wanted.id === row.id &&
      wanted.status === row.status) && row.hotel_id === 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6');
}
