import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function createDeliveryModule(sent) {
  const source = readFileSync(new URL('../src/lib/notifications/web-push.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const vapidCalls = [];
  vm.runInNewContext(code, {
    exports,
    process,
    console,
    require(name) {
      if (name === 'web-push') return { default: {
        setVapidDetails: (...args) => vapidCalls.push(args),
        sendNotification: async (subscription, payload) => {
          sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
        },
      } };
      if (name === '@/lib/constants') return { HOTEL_ID: 'cmpri-hotel' };
      if (name === '@/lib/notifications/schedule') {
        return {
          isWebPushEligibleProfile: (profile) => ['engineer', 'technician'].includes(profile.role),
          isWithinNotificationSchedule: (settings) => {
            const day = new Intl.DateTimeFormat('en', { timeZone: settings.timezone, weekday: 'long' })
              .format(new Date()).toLowerCase();
            return settings.schedule[day]?.enabled === true;
          },
          normalizeNotificationSettings: (settings) => settings,
        };
      }
      throw new Error(`Unexpected module ${name}`);
    },
  });
  return { exports, vapidCalls };
}

function makeAdmin(schedules, subscriptions) {
  const deliveries = [];
  const admin = {
    from(table) {
      let operation = 'select';
      let mutation;
      const filters = [];
      const query = {
        select() { if (operation === 'select') operation = 'select'; return query; },
        insert(value) { operation = 'insert'; mutation = value; return query; },
        update(value) { operation = 'update'; mutation = value; return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        maybeSingle() { return Promise.resolve(execute(true)); },
        then(resolve, reject) { return Promise.resolve(execute(false)).then(resolve, reject); },
      };
      function execute(single) {
        const valueFor = (key) => filters.find(([filterKey]) => filterKey === key)?.[1];
        if (table === 'cmpri_web_push_subscriptions' && operation === 'select') {
          return { data: subscriptions.filter((row) => row.recipient_user_id === valueFor('recipient_user_id')), error: null };
        }
        if (table === 'cmpri_user_notification_schedules' && operation === 'select') {
          return { data: schedules[valueFor('user_id')] || null, error: null };
        }
        if (table === 'cmpri_web_push_deliveries' && operation === 'insert') {
          const delivery = { id: `delivery-${deliveries.length + 1}`, ...mutation };
          deliveries.push(delivery);
          return { data: single ? { id: delivery.id } : null, error: null };
        }
        if (table === 'cmpri_web_push_deliveries' && operation === 'update') {
          const delivery = deliveries.find((row) => row.id === valueFor('id'));
          if (delivery) Object.assign(delivery, mutation);
          return { data: null, error: null };
        }
        throw new Error(`Unexpected query: ${table} ${operation}`);
      }
      return query;
    },
  };
  return { admin, deliveries };
}

function allDaySchedule(enabled) {
  return Object.fromEntries(
    ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
      .map((day) => [day, { enabled, start: '00:00', end: '00:00' }]),
  );
}

test('Chief Engineer and Maintenance Technician devices use separate schedules and delivery rows', async () => {
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = 'test-private-key';
  process.env.WEB_PUSH_VAPID_SUBJECT = 'mailto:test@example.invalid';
  const sent = [];
  const { exports, vapidCalls } = createDeliveryModule(sent);
  const schedules = {
    'chief-engineer-account': { timezone: 'UTC', schedule: allDaySchedule(true) },
    'technician-account': { timezone: 'UTC', schedule: allDaySchedule(false) },
  };
  const subscriptions = [
    { id: 'chief-device', recipient_user_id: 'chief-engineer-account', subscription: { endpoint: 'https://push.example/chief' } },
    { id: 'technician-device', recipient_user_id: 'technician-account', subscription: { endpoint: 'https://push.example/technician' } },
  ];
  const { admin, deliveries } = makeAdmin(schedules, subscriptions);
  const engineer = { role: 'engineer' };
  const technician = { role: 'technician' };

  await exports.dispatchWebPushNotifications(admin, 'chief-engineer-account', engineer, [
    { id: 'status-change:wo-1', message: 'Work order updated', target_path: '/work-orders/wo-1' },
  ]);
  await exports.dispatchWebPushNotifications(admin, 'technician-account', technician, [
    { id: 'new-order:wo-2', message: 'New work order', target_path: '/work-orders/wo-2' },
  ]);

  assert.deepEqual(sent.map((item) => item.endpoint), ['https://push.example/chief']);
  assert.deepEqual(deliveries.map((item) => item.status), ['sent', 'suppressed']);
  assert.equal(sent[0].payload.body, 'Work order updated');
  assert.equal(sent[0].payload.url, '/work-orders/wo-1');

  schedules['technician-account'].schedule = allDaySchedule(true);
  await exports.dispatchWebPushNotifications(admin, 'technician-account', technician, [
    { id: 'new-order:wo-3', message: 'New work order', target_path: '/work-orders/wo-3' },
  ]);
  assert.deepEqual(sent.map((item) => item.endpoint), [
    'https://push.example/chief',
    'https://push.example/technician',
  ]);
  assert.deepEqual(deliveries.map((item) => item.status), ['sent', 'suppressed', 'sent']);
  assert.equal(vapidCalls.length, 2);
});
