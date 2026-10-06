self.addEventListener("push", (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { body: event.data.text() };
    }
  }
  const title = typeof payload.title === "string" ? payload.title : "CMPRI Engineering";
  const body = typeof payload.body === "string" ? payload.body : "You have a new CMPRI notification.";
  const url = typeof payload.url === "string" ? payload.url : "/engineering";
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "/cmpri-push-icon.svg",
    badge: "/cmpri-push-icon.svg",
    tag: typeof payload.tag === "string" ? payload.tag : undefined,
    data: { url },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/engineering", self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      if ("navigate" in existing) void existing.navigate(target.href);
      return existing.focus();
    }
    return self.clients.openWindow(target.href);
  }));
});
