// Push notifications on this device (VISION §14): its id, whether it can take
// notifications, subscribing, and telling Atlas whether it's in view, so a
// message goes to one channel. The service worker is in public/sw.js.

/** This device's id: made once, kept in the browser. Without storage it lasts for this visit. */
let fallbackId: string | null = null;
export function deviceId(): string {
  try {
    let id = localStorage.getItem("atlas.device");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("atlas.device", id);
    }
    return id;
  } catch {
    fallbackId ??= crypto.randomUUID();
    return fallbackId;
  }
}

/** Registers the service worker once, at start. It caches nothing, so it can't serve a stale app. */
export function startServiceWorker(): void {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

export type PushState =
  | "on"
  | "off"
  /** The owner said no in the browser; only the browser's site settings can undo it. */
  | "blocked"
  /** An iPhone or iPad needs Atlas on the Home Screen first. */
  | "install"
  | "unsupported";

const isIOS = () => /iPhone|iPad/.test(navigator.userAgent);
const standalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/** Whether this device takes notifications from Atlas right now. */
export async function pushState(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return isIOS() && !standalone() ? "install" : "unsupported";
  }
  if (Notification.permission === "denied") return "blocked";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

const fromB64url = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/**
 * Asks the browser for permission and subscribes with this deployment's key.
 * Returns the subscription for Atlas, or why it couldn't.
 */
export async function subscribe(publicKey: string): Promise<{ sub: PushSubscriptionJSON } | { error: string }> {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return {
        error:
          permission === "denied" ? "Notifications are blocked for Atlas in this browser's settings." : "Notifications weren't allowed.",
      };
    }
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const old = await reg.pushManager.getSubscription();
    // A subscription made with another key (an older deployment) can't be used; make a fresh one.
    if (old) await old.unsubscribe();
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(publicKey) });
    return { sub: sub.toJSON() };
  } catch (err) {
    return { error: `The browser couldn't subscribe: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Stops notifications on this device, in the browser. */
export async function unsubscribe(): Promise<void> {
  const reg = await navigator.serviceWorker?.getRegistration();
  await (await reg?.pushManager.getSubscription())?.unsubscribe();
}

/** Whether Atlas is showing on this device: its tab is in front and the window isn't hidden. */
export const inView = () => document.visibilityState === "visible";
