// Weather from Open-Meteo (VISION §10.2): no key, free for non-commercial use,
// as a personal Atlas is. It only ever gets a rough area, about 10 km across,
// which the core rounds before calling (§4.4).

import { type Extension, type Hour, type Day, Failure, get } from "../sdk";

const UA = "Atlas/1.0 (personal assistant; https://github.com/maxjb-xyz/atlas)";

const ext: Extension = {
  manifest: {
    id: "open-meteo",
    name: "Open-Meteo",
    version: "1.0.0",
    about: "The weather for a rough area around you, from Open-Meteo. No key, free for personal use.",
    provides: ["weather"],
    hosts: ["api.open-meteo.com"],
  },
  async weather(ctx, area) {
    const u = new URL("https://api.open-meteo.com/v1/forecast");
    u.searchParams.set("latitude", String(area.lat));
    u.searchParams.set("longitude", String(area.lon));
    u.searchParams.set("current", "temperature_2m,apparent_temperature,weather_code,wind_speed_10m");
    u.searchParams.set("hourly", "temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m");
    u.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max");
    u.searchParams.set("timezone", "auto");
    u.searchParams.set("forecast_days", "7");
    u.searchParams.set("timeformat", "unixtime");
    const res = await get(u.toString(), { headers: { "user-agent": UA, accept: "application/json" } }, "Open-Meteo");
    const text = await res.text().catch(() => "");
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Said below with the status.
    }
    if (!res.ok || body.error) {
      const why = typeof body.reason === "string" ? body.reason : text.slice(0, 200);
      throw new Failure(
        `Open-Meteo (api.open-meteo.com) answered ${res.status}${why ? `: ${why}` : ""}`,
        res.status >= 500 ? "network" : "protocol",
        res.status,
      );
    }
    const cur = (body.current ?? {}) as Record<string, number>;
    const h = (body.hourly ?? {}) as Record<string, number[]>;
    const d = (body.daily ?? {}) as Record<string, number[]>;
    const now = ctx.now;
    const hours: Hour[] = (h.time ?? [])
      .map((t, i) => ({
        t: t * 1000,
        temp_c: h.temperature_2m?.[i] ?? NaN,
        pop: h.precipitation_probability?.[i] ?? 0,
        precip_mm: h.precipitation?.[i] ?? 0,
        code: h.weather_code?.[i] ?? 0,
        wind_kmh: h.wind_speed_10m?.[i] ?? 0,
      }))
      .filter((x) => x.t > now - 3_600_000)
      .slice(0, 24);
    const days: Day[] = (d.time ?? []).map((t, i) => ({
      date: new Date(t * 1000 + Number(body.utc_offset_seconds ?? 0) * 1000).toISOString().slice(0, 10),
      max_c: d.temperature_2m_max?.[i] ?? NaN,
      min_c: d.temperature_2m_min?.[i] ?? NaN,
      pop: d.precipitation_probability_max?.[i] ?? 0,
      code: d.weather_code?.[i] ?? 0,
      uv: d.uv_index_max?.[i] ?? 0,
    }));
    if (!hours.length || cur.temperature_2m == null) throw new Failure("Open-Meteo answered without a forecast.");
    return {
      at: now,
      area,
      now: {
        temp_c: cur.temperature_2m,
        feels_c: cur.apparent_temperature ?? cur.temperature_2m,
        code: cur.weather_code ?? 0,
        wind_kmh: cur.wind_speed_10m ?? 0,
      },
      hours,
      days,
    };
  },
};

export default ext;
