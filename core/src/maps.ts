// Maps (VISION §19.1): addresses, routes and what's nearby. Which service
// answers is an extension (§17): OpenStreetMap's free services by default,
// Mapbox by key for traffic, or another. The core keeps what every provider
// shares: the shapes of an answer and the kinds of place a task or a search
// can ask for, in OpenStreetMap's tags, the shared language of map data.
// Every call goes out through the outbox (core/src/outbox.ts) with a receipt.

export type { Found, Kind, Point, Route, Travel } from "../../extensions/sdk";
import type { Kind } from "../../extensions/sdk";

/** The maps extension the owner picked: "osm", "mapbox", or another's id. */
export type MapsProvider = string;

/** Kinds of place a task or a search can ask for, with OpenStreetMap's tags for each. */
export const KINDS = {
  grocery: { osm: ["shop=supermarket", "shop=grocery"], words: "a grocery store" },
  convenience: { osm: ["shop=convenience"], words: "a convenience store" },
  pharmacy: { osm: ["amenity=pharmacy", "shop=chemist"], words: "a pharmacy" },
  gas: { osm: ["amenity=fuel"], words: "a gas station" },
  coffee: { osm: ["amenity=cafe"], words: "a coffee shop" },
  restaurant: { osm: ["amenity=restaurant", "amenity=fast_food"], words: "a restaurant" },
  hardware: { osm: ["shop=hardware", "shop=doityourself"], words: "a hardware store" },
  bank: { osm: ["amenity=bank", "amenity=atm"], words: "a bank or ATM" },
  post: { osm: ["amenity=post_office"], words: "a post office" },
  bakery: { osm: ["shop=bakery"], words: "a bakery" },
  pet: { osm: ["shop=pet"], words: "a pet store" },
  electronics: { osm: ["shop=electronics"], words: "an electronics store" },
  clothes: { osm: ["shop=clothes"], words: "a clothes store" },
  charging: { osm: ["amenity=charging_station"], words: "an EV charger" },
} as const;
export type PlaceKind = keyof typeof KINDS;
export const PLACE_KINDS = Object.keys(KINDS) as [PlaceKind, ...PlaceKind[]];

/**
 * Any kind of place: one of the common kinds above, an OpenStreetMap tag
 * ("shop=florist", "leisure=park"), or a plain word ("florist"), which is
 * looked for as a shop or an amenity. Null when it isn't something a map
 * could look for.
 */
export function placeKind(kind: string): Kind | null {
  const k = kind.trim().toLowerCase();
  if (k in KINDS) {
    const known = KINDS[k as PlaceKind];
    return { osm: [...known.osm], words: known.words };
  }
  const tag = /^([a-z_:]{2,30})=([a-z0-9_;:-]{2,40})$/.exec(k);
  if (tag) return { osm: [k], words: tag[2]!.replace(/_/g, " ") };
  if (/^[a-z_]{2,40}$/.test(k)) return { osm: [`shop=${k}`, `amenity=${k}`], words: k.replace(/_/g, " ") };
  return null;
}

/** A kind of place in words. */
export const kindWords = (kind: string) => placeKind(kind)?.words ?? kind;

/** "12 min", "1 h 5 min". */
export function minutes(s: number): string {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
