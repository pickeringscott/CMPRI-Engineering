import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
export function loadWinterTs(path, dependencies = {}) {
  const url = new URL('../../' + path, import.meta.url);
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, Response, require: name => {
      if (name in dependencies) return dependencies[name];
      if (name.startsWith('.')) return loadWinterTs(new URL(name + '.ts', url).pathname.replace(/^.*\/winter-worktree\//, ''), dependencies);
      throw new Error(name);
    } });
  return exports;
}
export const actor = '00000000-0000-0000-0000-000000000001';
export const secondActor = '00000000-0000-0000-0000-000000000002';
export const hotel = '10000000-0000-0000-0000-000000000001';
export const otherHotel = '10000000-0000-0000-0000-000000000002';
export const principal = (role = 'Chief Engineer', id = actor, hotelId = hotel) => ({ identity: { id, email: 'fixture@example.invalid' }, profile: { id, role, active: true, full_name: id === actor ? 'Fixture Engineer' : 'Fixture Manager' }, hotelId, membership: { user_id: id, hotel_id: hotelId, active: true, role: 'admin' }, permissions: [] });
export const store = loadWinterTs('src/lib/server/winter-preparedness-store.ts');
export async function winterFixture() {
  const db = new PGlite();
  await db.exec(`create schema auth; create table auth.users(id uuid primary key); create table public.hotels(id uuid primary key); create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role; insert into auth.users values ('${actor}'),('${secondActor}'); insert into hotels values ('${hotel}'),('${otherHotel}');`);
  await db.exec('alter default privileges in schema public grant all on tables to anon, authenticated, service_role');
  await db.exec(readFileSync(new URL('../../supabase/migrations/20261026174026_winter_preparedness.sql', import.meta.url), 'utf8'));
  await db.exec('set role service_role');
  const client = { from(table) {
    if (table !== 'cmpri_winter_items') throw new Error('Unexpected table');
    let action = 'read', value, filters = [];
    const execute = async single => {
      try {
        let sql, values;
        const where = (offset = 0) => filters.map(([key], index) => `${key}=$${offset + index + 1}`).join(' and ');
        if (action === 'read') { sql = `select * from ${table} where ${where()}`; values = filters.map(([,value]) => value); }
        else if (action === 'insert') { const keys = Object.keys(value); values = Object.values(value); sql = `insert into ${table}(${keys.join(',')}) values (${keys.map((_,i)=>'$'+(i+1)).join(',')}) returning *`; }
        else { const keys = Object.keys(value); values = [...Object.values(value), ...filters.map(([,value]) => value)]; sql = `update ${table} set ${keys.map((key,i)=>`${key}=$${i+1}`).join(',')} where ${where(keys.length)} returning *`; }
        const result = await db.query(sql, values);
        return { data: single ? result.rows[0] || null : result.rows, error: null };
      } catch (error) { return { data: null, error }; }
    };
    const query = { select() { return query; }, eq(key, value) { filters.push([key, value]); return query; }, insert(data) { action = 'insert'; value = data; return query; }, update(data) { action = 'update'; value = data; return query; }, maybeSingle() { return execute(true); }, then(resolve, reject) { return execute(false).then(resolve, reject); } };
    return query;
  } };
  const auth = { ok: true, principal: principal(), admin: client, mcp: false };
  const route = loadWinterTs('src/app/api/winter-preparedness/route.ts', { '@/lib/server/auth': { requireUserAttempt: async () => auth }, '@/lib/server/winter-preparedness-store': store });
  return { db, client, auth, route, close: () => db.close() };
}
