// iCloud contacts over CardDAV (RFC 6352), read only. Discovery goes
// principal, then the address book home, then each address book. Errors
// keep the status and the host.

import { Failure } from "../sdk";
import { find, findAll, multistatus, textOf } from "./xml";

export const ICLOUD_CARDDAV = "https://contacts.icloud.com/";

const PROP = (inner: string) =>
  `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop>${inner}</d:prop></d:propfind>`;

/** Every card in the owner's iCloud contacts, as vCard text. */
export async function icloudVCards(auth: string, f: typeof fetch, base = ICLOUD_CARDDAV): Promise<string[]> {
  const dav = async (method: string, url: string, body: string, depth: "0" | "1") => {
    let target = url;
    for (let hop = 0; hop < 5; hop++) {
      let res: Response;
      try {
        res = await f(target, {
          method,
          headers: {
            Authorization: auth,
            "Content-Type": "application/xml; charset=utf-8",
            Depth: depth,
            "User-Agent": "Atlas/1.0 (CardDAV)",
          },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        throw new Failure(
          `Couldn't reach iCloud contacts at ${new URL(target).host}: ${err instanceof Error ? err.message : String(err)}`,
          "network",
        );
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        target = new URL(res.headers.get("location")!, target).toString();
        continue;
      }
      if (res.status === 401 || res.status === 403)
        throw new Failure(
          `iCloud contacts didn't accept the Apple ID and app-specific password (HTTP ${res.status} at ${new URL(target).host}).`,
          "auth",
          res.status,
        );
      if (res.status !== 207 && res.status !== 200)
        throw new Failure(
          `iCloud contacts answered HTTP ${res.status} at ${new URL(target).host}: ${(await res.text()).slice(0, 200)}`,
          "protocol",
          res.status,
        );
      return { url: target, responses: multistatus(await res.text()) };
    }
    throw new Failure("iCloud contacts redirected too many times.");
  };
  const hrefOf = (rs: Awaited<ReturnType<typeof dav>>, prop: string) => {
    for (const r of rs.responses) {
      const node = find(r.props, prop);
      const href = node ? textOf(node, "href") : undefined;
      if (href) return new URL(href, rs.url).toString();
    }
    throw new Failure(`iCloud contacts didn't say where your ${prop === "addressbook-home-set" ? "address books are" : "account is"}.`);
  };
  const principal = hrefOf(await dav("PROPFIND", base, PROP("<d:current-user-principal/>"), "0"), "current-user-principal");
  const home = hrefOf(await dav("PROPFIND", principal, PROP("<card:addressbook-home-set/>"), "0"), "addressbook-home-set");
  const books = await dav("PROPFIND", home, PROP("<d:resourcetype/>"), "1");
  const urls = books.responses
    .filter((r) => find(r.props, "resourcetype")?.children.some((x) => x.name === "addressbook"))
    .map((r) => new URL(r.href, books.url).toString());
  const out: string[] = [];
  for (const url of urls) {
    const got = await dav(
      "REPORT",
      url,
      `<?xml version="1.0" encoding="utf-8"?><card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><card:address-data/></d:prop></card:addressbook-query>`,
      "1",
    );
    for (const r of got.responses) for (const node of findAll(r.props, "address-data")) out.push(node.text);
  }
  return out;
}
