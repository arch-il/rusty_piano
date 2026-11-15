import { analyzeSlot, keyAlter, noteText } from './free-play-theory.ts';
import type { Slot } from './free-play-slots.ts';

const TREBLE = '<clef><sign>G</sign><line>2</line></clef>';
const BASS = '<clef><sign>F</sign><line>4</line></clef>';
const BARLINE = '<barline location="right"><bar-style>none</bar-style></barline>';

function attrs(fifths: number, clef: string): string {
  return `<attributes><divisions>1</divisions><key><fifths>${fifths}</fifths></key><time print-object="no"><beats>4</beats><beat-type>4</beat-type></time>${clef}</attributes>`;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clefXml(clef: Slot['clef']): string {
  return clef === 'treble' ? TREBLE : BASS;
}

export function freePlayXml(slots: readonly Slot[], fifths: number): string {
  let measures: string;
  if (slots.length === 0) {
    measures = `<measure number="1">${attrs(fifths, TREBLE)}<note print-object="no"><rest measure="yes"/><duration>4</duration><voice>1</voice></note>${BARLINE}</measure>`;
  } else {
    measures = slots
      .map((slot: Slot, i: number): string => {
        let body = '';
        if (i === 0) {
          body += attrs(fifths, clefXml(slot.clef));
        } else if (slot.clef !== slots[i - 1].clef) {
          body += `<attributes>${clefXml(slot.clef)}</attributes>`;
        }
        const r = analyzeSlot(slot.notes, fifths);
        if (r.name !== null) {
          body += `<direction placement="above"><direction-type><words>${esc(r.name)}</words></direction-type></direction>`;
        }
        r.notes.forEach((s, k: number): void => {
          const acc = s.alter === keyAlter(s.step, fifths)
            ? ''
            : `<accidental>${s.alter === 1 ? 'sharp' : s.alter === -1 ? 'flat' : 'natural'}</accidental>`;
          body += `<note>${k > 0 ? '<chord/>' : ''}<pitch><step>${s.step}</step>${s.alter !== 0 ? `<alter>${s.alter}</alter>` : ''}<octave>${s.octave}</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type>${acc}</note>`;
        });
        body += BARLINE;
        return `<measure number="${i + 1}">${body}</measure>`;
      })
      .join('');
  }
  return '<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name print-object="no">Piano</part-name></score-part></part-list><part id="P1">' + measures + '</part></score-partwise>';
}

export function fallbackText(slots: readonly Slot[], fifths: number): string {
  return slots
    .map((slot: Slot): string => {
      const r = analyzeSlot(slot.notes, fifths);
      const notesStr = r.notes.map(noteText).join(' ');
      return r.name ? `${r.name} (${notesStr})` : notesStr;
    })
    .join(' | ');
}
