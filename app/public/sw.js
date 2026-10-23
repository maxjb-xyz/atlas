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
  // An approval that a tap can give gets an Approve button; one that needs a hold opens Inbox instead.
  const canApprove = d.approval && !d.hold;
  event.waitUntil(
    self.registration.showNotification(d.title || "Atlas", {
      body: d.body || "",
      tag: d.tag,
      icon: "/icon-512.png",
      data: { url: d.url || "/", approval: d.approval || null },
      ...(canApprove ? { actions: [{ action: "approve", title: "Approve" }] } : {}),
    }),
  );
});

async function openAtlas(url) {
  const open = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).find((c) => new URL(c.url).origin === self.location.origin);
  if (open) {
    await open.focus();
    if (open.navigate) await open.navigate(url).catch(() => {});
  } else await self.clients.openWindow(url);
}

/** Tells Atlas how a notification was taken, so nudges it sent on its own learn from it (§10.3). */
function reacted(tag, how) {
  if (!tag) return Promise.resolve();
  return fetch("/api/reaction", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: tag, how }),
  }).catch(() => {});
}

self.addEventListener("notificationclose", (event) => event.waitUntil(reacted(event.notification.tag, "dismissed")));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = new URL(data.url || "/", self.location.origin).href;
  event.waitUntil(reacted(event.notification.tag, "opened"));
  if (event.action === "approve" && data.approval) {
    // Approve without opening Atlas; if that doesn't work, open Inbox so the card is there.
    event.waitUntil(
      fetch("/api/approve", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: data.approval }),
      })
        .then((res) => (res.ok ? null : openAtlas(new URL("/#/inbox", self.location.origin).href)))
        .catch(() => openAtlas(new URL("/#/inbox", self.location.origin).href)),
    );
    return;
  }
  event.waitUntil(openAtlas(url));
});
