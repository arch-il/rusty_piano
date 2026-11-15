// MusicXML builder for sight-reading cards. Pure string building, no DOM. The XML is
// fed to OSMD for display and to the score timeline for playing.

import { keyAlter, spell } from './sight-gen.ts';
import type { Card, CardNote, Pitch } from './sight-levels.ts';

export interface XmlMarks {
  done?: number;
  wrong?: { step: number; note: number } | null;
  colors?: { done: string; wrong: string; current?: string };
}

export const DEFAULT_XML_COLORS = { done: '#2e8b45', wrong: '#c8322a' };

export const WRONG_ANCHOR_COLOR = '#010101';

export function wrongNoteOffset(
  card: Card,
  marks: XmlMarks,
): { halfSpaces: number; accidental: 'sharp' | 'flat' | 'natural' | null } | null {
  const w = marks.wrong;
  if (!w) return null;
  const step = card.steps[w.step];
  if (!step) return null;
  const target = step.notes[0].pitch;
  const wrong = spell(w.note, card.fifths, false);
  const index = (p: Pitch) => p.octave * 7 + 'CDEFGAB'.indexOf(p.step);
  const accidental =
    wrong.alter === keyAlter(wrong.step, card.fifths) ? null : wrong.alter === 1 ? 'sharp' : wrong.alter === -1 ? 'flat' : 'natural';
  return { halfSpaces: index(wrong) - index(target), accidental };
}

interface Colors {
  done: string;
  wrong: string;
  current?: string;
}

export function typeOf(quarters: number): string {
  return quarters >= 4 ? 'whole' : quarters >= 2 ? 'half' : 'quarter';
}

function alterName(alter: number): string {
  return alter === 1 ? 'sharp' : alter === -1 ? 'flat' : 'natural';
}

export function noteXml(
  pitch: Pitch,
  quarters: number,
  opts: { chord: boolean; color: string | null; staff: number | null; voice: number; fifths: number },
): string {
  const color = opts.color ? ` color="${opts.color}"` : '';
  const chord = opts.chord ? '<chord/>' : '';
  const alter = pitch.alter === 0 ? '' : `<alter>${pitch.alter}</alter>`;
  const accidental =
    pitch.alter === keyAlter(pitch.step, opts.fifths) ? '' : `<accidental>${alterName(pitch.alter)}</accidental>`;
  const head = opts.color ? `<notehead color="${opts.color}">normal</notehead>` : '';
  const staff = opts.staff === null ? '' : `<staff>${opts.staff}</staff>`;
  return `<note${color}>${chord}<pitch><step>${pitch.step}</step>${alter}<octave>${pitch.octave}</octave></pitch><duration>${quarters}</duration><voice>${opts.voice}</voice><type>${typeOf(quarters)}</type>${accidental}${head}${staff}</note>`;
}

export function restsXml(quarters: number, staff: number, sv: number | null): string {
  let out = '';
  let left = quarters;
  while (left > 0) {
    const d = left >= 4 ? 4 : left >= 2 ? 2 : 1;
    const staffTag = sv === null ? '' : `<staff>${sv}</staff>`;
    out += `<note><rest/><duration>${d}</duration><voice>${staff}</voice><type>${typeOf(d)}</type>${staffTag}</note>`;
    left -= d;
  }
  return out;
}

export function attributesXml(card: Card): string {
  const time = `<time${card.showTime ? '' : ' print-object="no"'}><beats>4</beats><beat-type>4</beat-type></time>`;
  const clef =
    card.clef === 'grand'
      ? '<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>'
      : card.clef === 'treble'
        ? '<clef><sign>G</sign><line>2</line></clef>'
        : '<clef><sign>F</sign><line>4</line></clef>';
  return `<attributes><divisions>1</divisions><key><fifths>${card.fifths}</fifths></key>${time}${clef}</attributes>`;
}

export function staffXml(card: Card, staff: number, start: number, end: number, marks: XmlMarks, colors: Colors): string {
  const sv = card.clef === 'grand' ? staff : null;
  const doneCount = marks.done ?? 0;
  const out: string[] = [];
  let cursor = start;
  let any = false;
  card.steps.forEach((step, index) => {
    if (step.time < start || step.time >= end) return;
    const notes = step.notes.filter((n) => n.staff === staff);
    if (notes.length === 0) return;
    any = true;
    out.push(restsXml(step.time - cursor, staff, sv));
    const color = index < doneCount ? colors.done : index === doneCount && colors.current ? colors.current : null;
    const anchored = marks.wrong && marks.wrong.step === index ? step.notes[0] : null;
    notes.forEach((n: CardNote, k) => {
      const c = n === anchored ? WRONG_ANCHOR_COLOR : color;
      out.push(noteXml(n.pitch, n.quarters, { chord: k > 0, color: c, staff: sv, voice: staff, fifths: card.fifths }));
    });
    cursor = step.time + Math.max(...notes.map((n) => n.quarters));
  });
  if (!any) return measureRestXml(staff, sv);
  out.push(restsXml(end - cursor, staff, sv));
  return out.join('');
}

export function measureRestXml(staff: number, sv: number | null): string {
  const staffTag = sv === null ? '' : `<staff>${sv}</staff>`;
  return `<note><rest measure="yes"/><duration>4</duration><voice>${staff}</voice>${staffTag}</note>`;
}

function measureXml(card: Card, m: number, marks: XmlMarks, colors: Colors): string {
  const start = 4 * m;
  const end = start + 4;
  const staves = card.clef === 'grand' ? [1, 2] : [1];
  const parts: string[] = [];
  if (m === 0) parts.push(attributesXml(card));
  for (const staff of staves) {
    if (staff === 2) parts.push('<backup><duration>4</duration></backup>');
    parts.push(staffXml(card, staff, start, end, marks, colors));
  }
  if (m === card.measures - 1) parts.push('<barline location="right"><bar-style>light-heavy</bar-style></barline>');
  return `<measure number="${m + 1}">${parts.join('')}</measure>`;
}

export function cardXml(card: Card, marks: XmlMarks = {}): string {
  const colors = marks.colors ?? DEFAULT_XML_COLORS;
  const measures: string[] = [];
  for (let m = 0; m < card.measures; m++) measures.push(measureXml(card, m, marks, colors));
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<score-partwise version="4.0"><part-list><score-part id="P1"><part-name print-object="no">Piano</part-name></score-part></part-list><part id="P1">' +
    measures.join('') +
    '</part></score-partwise>'
  );
}
