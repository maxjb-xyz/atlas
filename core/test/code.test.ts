import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams } from "../src/agent";
import { call, fakeCalendar, fakeEmbedder, say } from "./helpers";
import { brain, connect, inOwner, out, turn } from "./owner";

let searched: string[] = [];

beforeEach(() => {
  searched = [];
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
  seams.websearch = async (req) => {
    searched.push(req.query);
    return Response.json({
      items: [{ url: `https://example.com/${encodeURIComponent(req.query)}`, title: `About ${req.query}`, description: "…" }],
    });
  };
  seams.fetch = (async () => new Response("ok")) as unknown as typeof fetch;
});
afterEach(() => {
  seams.websearch = undefined;
  seams.fetch = null;
  seams.makeBrain = null;
  seams.calendar = undefined;
  seams.embed = undefined;
});

describe("Code Mode", () => {
  it("runs one program over many tools in a Dynamic Worker, each call with its receipt", async () => {
    const s = await connect();
    await inOwner((_a, sql) => sql.exec(`DELETE FROM state WHERE key = 'trust'`));
    const code = `async () => {
      const queries = ["pho near UCF", "banh mi near UCF", "ramen near UCF"];
      const all = await Promise.all(queries.map((query) => atlas.web_search({ query, count: 1 })));
      console.log("searched", all.length);
      return all.map((r) => r.results[0].title);
    }`;
    brain([call("code_run", { code }), say("Three options.")]);
    const { results } = await turn(s, "compare three lunch spots");
    const program = results.find((r) => r.body.name === "code_run")!;
    expect(JSON.parse(out(program))).toEqual({
      result: ["About pho near UCF", "About banh mi near UCF", "About ramen near UCF"],
      logs: ["searched 3"],
      calls: 3,
      called: "web_search ×3",
    });
    expect(program.body.receipt).toEqual({ text: "Ran a program · 3 calls (web_search ×3)", look: true });
    expect(searched.sort()).toEqual(["banh mi near UCF", "pho near UCF", "ramen near UCF"]);
    // Each call inside is a row of the run, with its own receipt, as if Atlas had made it.
    const inner = results.filter((r) => r.body.via === "code");
    expect(inner.map((r) => (r.body.receipt as { text: string }).text).sort()).toEqual([
      "Searched · banh mi near UCF",
      "Searched · pho near UCF",
      "Searched · ramen near UCF",
    ]);
  });

  it("asks for the owner's OK inside a program just as outside it", async () => {
    const s = await connect();
    s.send({
      type: "atlas.webhook.save",
      name: "Code lamp",
      url: "https://hooks.example.com/code-lamp-1",
      method: "POST",
      about: "A lamp",
    });
    await s.next("atlas.view", (m) => m.view.webhooks.some((w) => w.name === "Code lamp"));
    brain([call("code_run", { code: "async () => atlas.webhook_call({ webhook: 'Code lamp' })" }), say("Waiting for your OK.")]);
    const { results } = await turn(s, "turn on the lamp in a program");
    expect(JSON.parse(out(results.find((r) => r.body.name === "code_run")!))).toMatchObject({
      result: { waiting_for_ok: expect.stringMatching(/^ag_/) },
    });
    expect(results.find((r) => r.body.via === "code")!.body.receipt).toMatchObject({ text: "Waiting for your OK · Code lamp" });
  });

  it("has no network of its own, stops at its call limit, and says what went wrong", async () => {
    const s = await connect();
    brain([
      call("code_run", { code: "async () => { const r = await fetch('https://example.com'); return r.status; }" }, "a"),
      call("code_run", { code: "async () => { for (let i = 0; i < 70; i++) await atlas.agenda_list({}); }" }, "b"),
      call("code_run", { code: "async () => atlas.web_search({ nope: true })" }, "c"),
      call("code_run", { code: "async () => { this is not javascript }" }, "d"),
      say("Done."),
    ]);
    const { results } = await turn(s, "try things");
    const programs = results.filter((r) => r.body.name === "code_run").map((r) => JSON.parse(out(r)) as Record<string, unknown>);
    expect(String(programs[0]!.error)).toContain("not permitted to access the internet");
    expect(String(programs[1]!.error)).toContain("more than 60 tool calls");
    expect(JSON.stringify(programs[2]!.result)).toContain("Those arguments don't fit web_search");
    expect(String(programs[3]!.error)).toContain("SyntaxError");
    expect(searched).toEqual([]);
  });
});
