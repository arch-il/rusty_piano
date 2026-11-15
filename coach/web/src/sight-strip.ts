// Continuous strip of upcoming cards for the per-card levels. Pure string building, no DOM.

import { attributesXml, staffXml } from './sight-xml.ts';
import type { XmlMarks } from './sight-xml.ts';
import type { Card } from './sight-levels.ts';

export const STRIP_SIZE = 8;
export const STRIP_SHIFT_AT = 5;
export const STRIP_KEEP = 1;

export function stripStart(prevStart: number, current: number, total: number): number {
  let start = prevStart;
  if (current < prevStart) start = current - STRIP_KEEP;
  else if (current - prevStart >= STRIP_SHIFT_AT) start = current - STRIP_KEEP;
  start = Math.min(start, Math.max(0, total - STRIP_SIZE));
  return Math.max(0, Math.min(start, current));
}

type StripColors = { done: string; wrong: string; current: string };

function clefXml(card: Card): string {
  return card.clef === 'treble' ? '<clef><sign>G</sign><line>2</line></clef>' : '<clef><sign>F</sign><line>4</line></clef>';
}

export function stripXml(
  cards: readonly Card[],
  start: number,
  current: number,
  marks: XmlMarks,
  colors: StripColors,
): string {
  const end = Math.min(cards.length, start + STRIP_SIZE);
  const window = cards.slice(start, end);
  const grand = window.some((c) => c.clef === 'grand');
  const measures: string[] = [];
  window.forEach((card, i) => {
    const idx = start + i;
    const parts: string[] = [];
    if (i === 0) {
      parts.push(attributesXml({ ...card, showTime: false, clef: grand ? 'grand' : card.clef }));
    } else {
      const prev = window[i - 1];
      const changes =
        (card.fifths !== prev.fifths ? `<key><fifths>${card.fifths}</fifths></key>` : '') +
        (!grand && card.clef !== prev.clef ? clefXml(card) : '');
      if (changes) parts.push(`<attributes>${changes}</attributes>`);
    }
    const cardMarks: XmlMarks =
      idx < current
        ? { done: card.steps.length, colors }
        : idx === current
          ? { done: marks.done, wrong: marks.wrong, colors }
          : { done: 0, colors: { done: colors.done, wrong: colors.wrong } };
    const cardColors = cardMarks.colors ?? colors;
    const staves = grand ? [1, 2] : [1];
    for (const staff of staves) {
      if (staff === 2) parts.push('<backup><duration>4</duration></backup>');
      parts.push(staffXml({ ...card, clef: grand ? 'grand' : card.clef }, staff, 0, 4, cardMarks, cardColors));
    }
    if (end === cards.length && i === window.length - 1) {
      parts.push('<barline location="right"><bar-style>light-heavy</bar-style></barline>');
    }
    measures.push(`<measure number="${i + 1}">${parts.join('')}</measure>`);
  });
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<score-partwise version="4.0"><part-list><score-part id="P1"><part-name print-object="no">Piano</part-name></score-part></part-list><part id="P1">' +
    measures.join('') +
    '</part></score-partwise>'
  );
}
