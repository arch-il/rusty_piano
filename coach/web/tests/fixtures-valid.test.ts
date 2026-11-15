import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "fixtures");
const files = readdirSync(dir).filter((f) => f.endsWith(".musicxml"));

for (const file of files) {
  const xml = readFileSync(join(dir, file), "utf8");

  test(`${file}: every direction has a direction-type`, () => {
    const directions = xml.match(/<direction(\s[^>]*)?>[\s\S]*?<\/direction>/g) ?? [];
    for (const d of directions) {
      assert.ok(d.includes("<direction-type>"), `direction without direction-type: ${d}`);
    }
  });

  test(`${file}: left barline comes before the first note`, () => {
    const measures = xml.match(/<measure[\s>][\s\S]*?<\/measure>/g) ?? [];
    for (const m of measures) {
      const left = m.search(/<barline location="left"/);
      if (left === -1) continue;
      const note = m.indexOf("<note");
      assert.ok(note === -1 || left < note, `left barline after first note in: ${m.slice(0, 40)}`);
    }
  });

  test(`${file}: jump directions come after the first note`, () => {
    const measures = xml.match(/<measure[\s>][\s\S]*?<\/measure>/g) ?? [];
    for (const m of measures) {
      const note = m.indexOf("<note");
      for (const d of m.matchAll(/<direction(?:\s[^>]*)?>[\s\S]*?<\/direction>/g)) {
        const words = [...d[0].matchAll(/<words\b[^>]*>([\s\S]*?)<\/words>/g)].map((w) => w[1]).join("").trim();
        const byWords = /^(d\.c\.|d\.s\.|to coda|fine)(\s+al\s+\S+)?$/i.test(words);
        const bySound = /<sound\b[^>]*\b(dacapo|dalsegno|tocoda|fine)\s*=/.test(d[0]);
        if (byWords || bySound) {
          assert.ok(note === -1 || d.index > note, `jump direction before the first note: ${d[0]}`);
        }
      }
    }
  });

  test(`${file}: exactly one part`, () => {
    const parts = xml.match(/<part id=/g) ?? [];
    assert.equal(parts.length, 1);
  });
}
