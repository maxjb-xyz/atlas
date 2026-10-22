import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams } from "../src/agent";
import { parseTable } from "../src/files";
import { call, env, fakeCalendar, fakeEmbedder, say, SECRET } from "./helpers";
import { brain, connect, inOwner, out, turn } from "./owner";

const CSV = 'When,What\n"Oct 24, 9:00",Call the landlord\nOct 25,"Pick up the ""good"" lens"\n';

beforeEach(async () => {
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
  await inOwner((_a, sql) => sql.exec(`DELETE FROM files`));
});
afterEach(() => {
  seams.makeBrain = null;
  seams.calendar = undefined;
  seams.embed = undefined;
});

describe("files", () => {
  it("reads CSV the way spreadsheets write it", () => {
    expect(parseTable(CSV, false).rows).toEqual([
      ["When", "What"],
      ["Oct 24, 9:00", "Call the landlord"],
      ["Oct 25", 'Pick up the "good" lens'],
    ]);
    expect(parseTable("a\tb\r\n1\t2", true).rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("makes a text file in R2, shows it as a table, downloads it safely, reads it back, and replaces it by name", async () => {
    const s = await connect();
    brain([
      call("file_save", { name: "reminders-october.csv", text: CSV, note: "Your reminders this month" }),
      say("Here's the spreadsheet."),
    ]);
    const { results } = await turn(s, "make a spreadsheet of my reminders this month");
    const receipt = results[0]!.body.receipt as { text: string; view: { kind: string; file: string } };
    expect(receipt.text).toBe("Made file · reminders-october.csv");
    const id = receipt.view.file;

    // In R2, and in Library's list.
    expect(await (await env.FILES.get(`files/${id}`))!.text()).toBe(CSV);
    s.send({ type: "atlas.files" });
    const listed = await s.next("atlas.files");
    expect(listed.files).toEqual([
      expect.objectContaining({ id, name: "reminders-october.csv", type: "text/csv", made_by: "atlas", note: "Your reminders this month" }),
    ]);

    // On the stage: a table, and where to download it.
    s.send({ type: "atlas.stage", ref: `file:${id}`, view: { kind: "file", file: id } });
    const page = (await s.next("atlas.stage.page", (m) => m.ref === `file:${id}`)).page;
    expect(page).toMatchObject({
      kind: "file",
      file: { name: "reminders-october.csv", url: `/api/files/${id}` },
      preview: {
        kind: "table",
        columns: ["When", "What"],
        rows: [
          ["Oct 24, 9:00", "Call the landlord"],
          ["Oct 25", 'Pick up the "good" lens'],
        ],
      },
    });

    // The download is the owner's only, and sandboxed so a file can't run scripts as Atlas.
    expect((await SELF.fetch(`http://atlas.test/api/files/${id}`)).status).toBe(401);
    const res = await SELF.fetch(`http://atlas.test/api/files/${id}`, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''reminders-october.csv");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(await res.text()).toBe(CSV);

    // Atlas reads it back, and saving the same name replaces it.
    brain([
      call("file_read", { file: "reminders-october.csv" }),
      call("file_save", { name: "reminders-october.csv", text: "When,What\n" }),
      say("Updated."),
    ]);
    const again = await turn(s, "read it and clear it");
    expect(out(again.results[0]!)).toContain("Call the landlord");
    expect(again.results[1]!.body.receipt).toMatchObject({
      text: "Replaced file · reminders-october.csv",
      view: { kind: "file", file: id },
    });

    // A file that isn't text is the workspace's to make.
    brain([call("file_save", { name: "budget.xlsx", text: "nope" }), say("I'll make it in the workspace.")]);
    const xlsx = await turn(s, "make an excel file");
    expect(out(xlsx.results[0]!)).toContain("isn't a text file. Make it in the workspace");

    // Deleting it in Library takes it out of R2 too.
    s.send({ type: "atlas.file.delete", id });
    expect((await s.next("atlas.files")).files).toEqual([]);
    expect(await env.FILES.get(`files/${id}`)).toBeNull();
  });

  it("refuses a name that isn't a file name", async () => {
    const s = await connect();
    brain([call("file_save", { name: "../.env", text: "x" }), say("Bad name.")]);
    const { results } = await turn(s, "save it");
    expect(out(results[0]!)).toContain("isn't a file name Atlas can use");
  });
});
