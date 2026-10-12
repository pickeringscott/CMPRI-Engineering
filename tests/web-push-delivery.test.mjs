import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import webpush from 'web-push';

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
        sendNotification: async (subscription, payload, options) => {
          sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options });
        },
      } };
      if (name === '@/lib/constants') return { HOTEL_ID: 'cmpri-hotel' };
      if (name === '@/lib/notifications/schedule') {
        return {
          isWebPushEligibleProfile: (profile) => ['Chief Engineer', 'Maintenance Technician'].includes(profile.role),
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
      let returning = false;
      const query = {
        select() { returning = true; return query; },
        insert(value) { operation = 'insert'; mutation = value; return query; },
        update(value) { operation = 'update'; mutation = value; return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        in(key, value) { filters.push([key, value]); return query; },
        lt(key, value) { filters.push([key, value]); return query; },
        is(key, value) { filters.push([key, value]); return query; },
        maybeSingle() { return Promise.resolve(execute(true)); },
        then(resolve, reject) { return Promise.resolve(execute(false)).then(resolve, reject); },
      };
      function execute(single) {
        const matches = (row) => filters.every(([key, value]) => {
          if (Array.isArray(value)) return value.includes(row[key]);
          return row[key] === value;
        });
        if (table === 'cmpri_web_push_subscriptions' && operation === 'select') {
          return { data: subscriptions.filter(matches), error: null };
        }
        if (table === 'cmpri_user_notification_schedules' && operation === 'select') {
          return { data: schedules[filters.find(([key]) => key === 'user_id')?.[1]] || null, error: null };
        }
        if (table === 'cmpri_web_push_deliveries' && operation === 'insert') {
          const duplicate = deliveries.some((row) =>
            ['hotel_id', 'recipient_user_id', 'subscription_id', 'notification_key']
              .every((key) => row[key] === mutation[key]),
          );
          if (duplicate) return { data: null, error: { code: '23505' } };
          const delivery = { id: `delivery-${deliveries.length + 1}`, ...mutation };
          deliveries.push(delivery);
          return { data: single ? { id: delivery.id } : null, error: null };
        }
        if (table === 'cmpri_web_push_deliveries' && operation === 'select') {
          const data = deliveries.filter(matches);
          return { data: single ? data[0] || null : data, error: null };
        }
        if (table === 'cmpri_web_push_deliveries' && operation === 'update') {
          const data = deliveries.filter(matches);
          data.forEach((delivery) => Object.assign(delivery, mutation));
          return { data: returning ? (single ? data[0] || null : data) : null, error: null };
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

test('quiet-hour deliveries remain pending and send once when notification hours resume', async () => {
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
    { id: 'chief-device', hotel_id: 'cmpri-hotel', recipient_user_id: 'chief-engineer-account', enabled: true, subscription: { endpoint: 'https://push.example/chief' } },
    { id: 'technician-device', hotel_id: 'cmpri-hotel', recipient_user_id: 'technician-account', enabled: true, subscription: { endpoint: 'https://push.example/technician' } },
  ];
  const { admin, deliveries } = makeAdmin(schedules, subscriptions);
  const engineer = { role: 'Chief Engineer' };
  const technician = { role: 'Maintenance Technician' };

  await exports.dispatchWebPushNotifications(admin, 'chief-engineer-account', engineer, [
    { id: 'status-change:wo-1', work_order_id: 'wo-1', message: 'Work order updated' },
  ]);
  await exports.dispatchWebPushNotifications(admin, 'technician-account', technician, [
    { id: 'new-order:wo-2', message: 'New work order', target_path: '/work-orders/wo-2' },
  ]);

  assert.deepEqual(sent.map((item) => item.endpoint), ['https://push.example/chief']);
  assert.deepEqual(deliveries.map((item) => item.status), ['sent', 'pending']);
  assert.equal(sent[0].payload.body, 'Work order updated');
  assert.equal(sent[0].payload.url, '/work-orders/wo-1');

  schedules['technician-account'].schedule = allDaySchedule(true);
  await exports.dispatchWebPushNotifications(admin, 'technician-account', technician, [
    { id: 'new-order:wo-2', message: 'New work order', target_path: '/work-orders/wo-2' },
  ]);
  await exports.dispatchWebPushNotifications(admin, 'technician-account', technician, [
    { id: 'new-order:wo-2', message: 'New work order', target_path: '/work-orders/wo-2' },
  ]);
  assert.deepEqual(sent.map((item) => item.endpoint), [
    'https://push.example/chief',
    'https://push.example/technician',
  ]);
  assert.deepEqual(deliveries.map((item) => item.status), ['sent', 'sent']);
  assert.equal(sent[1].payload.url, '/work-orders/wo-2');
  assert.equal(vapidCalls.length, 3);
});

test('work-order push delivery rejects roles outside Chief Engineer and Maintenance Technician', async () => {
  const sent = [];
  const { exports } = createDeliveryModule(sent);
  const { admin } = makeAdmin({}, [
    { id: 'manager-device', hotel_id: 'cmpri-hotel', recipient_user_id: 'manager-account', enabled: true, subscription: { endpoint: 'https://push.example/manager' } },
  ]);
  await exports.dispatchWebPushNotifications(admin, 'manager-account', { role: 'Engineering Manager' }, [
    { id: 'history:wo-1', message: 'Status changed' },
  ]);
  assert.deepEqual(sent, []);
});

test('visible alerts request high urgency for each subscription without resending accepted deliveries', async () => {
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = 'test-private-key';
  process.env.WEB_PUSH_VAPID_SUBJECT = 'mailto:test@example.invalid';
  const sent = [];
  const { exports } = createDeliveryModule(sent);
  const { admin, deliveries } = makeAdmin({
    technician: { timezone: 'UTC', schedule: allDaySchedule(true) },
  }, ['device-a', 'device-b'].map((id) => ({
    id, hotel_id: 'cmpri-hotel', recipient_user_id: 'technician', enabled: true,
    subscription: { endpoint: `https://push.example.invalid/${id}` },
  })));
  const notification = { id: 'new-order:local-fixture', message: 'New work order', target_path: '/work-orders/local-fixture' };
  for (let attempt = 0; attempt < 2; attempt++) {
    await exports.dispatchWebPushNotifications(admin, 'technician', { role: 'Maintenance Technician' }, [notification]);
  }
  assert.equal(sent.length, 2);
  assert.deepEqual(deliveries.map((item) => item.status), ['sent', 'sent']);
  for (const item of sent) {
    // Build headers with the installed library, without credentials or network I/O.
    const request = webpush.generateRequestDetails({ endpoint: item.endpoint }, null, item.options);
    assert.equal(request.headers.Urgency, 'high');
    assert.equal(item.payload.url, notification.target_path);
  }
});

test('push worker displays the existing payload with no open app and extends its lifetime until display completes', async () => {
  const handlers = new Map();
  const shown = [];
  let finishDisplay;
  const display = new Promise((resolve) => { finishDisplay = resolve; });
  // No window, document, open clients, or network API: background display must be independent of the page.
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), {
    self: {
      addEventListener: (name, handler) => handlers.set(name, handler),
      registration: { showNotification: (title, options) => {
        shown.push({ title, options });
        return display;
      } },
    },
  });
  let lifetime;
  handlers.get('push')({
    data: { json: () => ({ title: 'CMPRI Engineering', body: 'New work order', url: '/work-orders/local-fixture', tag: 'cmpri-new-order:local-fixture' }) },
    waitUntil: (promise) => { lifetime = promise; },
  });
  assert.equal(lifetime, display);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'CMPRI Engineering');
  assert.equal(shown[0].options.body, 'New work order');
  assert.equal(shown[0].options.data.url, '/work-orders/local-fixture');
  assert.equal(shown[0].options.tag, 'cmpri-new-order:local-fixture');
  assert.notEqual(shown[0].options.silent, true);
  for (const key of ['icon', 'badge']) {
    const png = readFileSync(new URL(`../public${shown[0].options[key]}`, import.meta.url));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
  finishDisplay();
  await lifetime;
});
