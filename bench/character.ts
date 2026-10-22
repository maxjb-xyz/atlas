// The character eval (VISION §23.1) against a deployed Atlas: every brain in
// the chains answers old Atlas's sixteen prompts under Atlas's own prompt,
// and a different brain judges each reply against docs/CHARACTER.md.
//
//   ATLAS_OWNER_SECRET=... npm run eval:character -- --url https://atlas.<you>.workers.dev
//
// Exits non-zero if any reply breaks character. The same check runs from
// Settings → Character & voice.

export {};

const args = process.argv.slice(2);
const url = args[args.indexOf("--url") + 1];
const secret = process.env.ATLAS_OWNER_SECRET ?? "";
if (!args.includes("--url") || !url || !secret) {
  console.error("Usage: ATLAS_OWNER_SECRET=... npm run eval:character -- --url https://atlas.<you>.workers.dev");
  process.exit(2);
}

interface Check {
  brain: string;
  judge: string | null;
  note?: string;
  results: Array<{ id: string; reply: string; verdict: { passed: boolean; failed: string[]; notes: string } }>;
}

const res = await fetch(new URL("/api/character-check", url), { method: "POST", headers: { authorization: `Bearer ${secret}` } });
if (!res.ok) {
  console.error(`The check failed: HTTP ${res.status} from ${new URL(url).host}: ${(await res.text()).slice(0, 500)}`);
  process.exit(1);
}
const out = (await res.json()) as { ok: boolean; message: string; detail: Check[] };
for (const c of out.detail) {
  console.log(`== ${c.brain} (judged by ${c.judge ?? "nobody"})`);
  if (c.note) console.log(`   not checked: ${c.note}`);
  for (const r of c.results) {
    const why = r.verdict.failed.length ? ` (${r.verdict.failed.join(", ")})${r.verdict.notes ? `: ${r.verdict.notes}` : ""}` : "";
    console.log(`${r.verdict.passed ? "PASS" : "FAIL"}  ${r.id}${why}`);
    if (!r.verdict.passed) console.log(`      replied: ${r.reply.replace(/\n/g, " / ").slice(0, 300)}`);
  }
}
console.log(`\n${out.message}`);
process.exit(out.ok ? 0 : 1);
