// Atlas's service worker: shows push notifications (VISION §14) and opens
// Atlas when one is tapped. It caches nothing; the app always loads fresh.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(d.title || "Atlas", {
      body: d.body || "",
      tag: d.tag,
      icon: "/icon-512.png",
      data: { url: d.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const open = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).find(
        (c) => new URL(c.url).origin === self.location.origin,
      );
      if (open) await open.focus();
      else await self.clients.openWindow(url);
    })(),
  );
});
