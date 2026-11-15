// Melodies for the ear-training tune levels. All melodies are traditional or public domain.
// Notes are MIDI pitches in C major (C4 = 60); beats are in quarter notes.

export interface TunePhrase {
  notes: number[];
  beats: number[];
}

export interface Tune {
  id: string;
  title: string;
  phrases: TunePhrase[];
}

export const TUNES: readonly Tune[] = [
  {
    id: 'hot-cross-buns',
    title: 'Hot Cross Buns',
    phrases: [
      { notes: [64, 62, 60], beats: [1, 1, 2] },
      {
        notes: [60, 60, 60, 60, 62, 62, 62, 62, 64, 62, 60],
        beats: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 1, 2],
      },
    ],
  },
  {
    id: 'mary',
    title: 'Mary Had a Little Lamb',
    phrases: [
      { notes: [64, 62, 60, 62, 64, 64, 64], beats: [1, 1, 1, 1, 1, 1, 2] },
      { notes: [62, 62, 62, 64, 67, 67], beats: [1, 1, 2, 1, 1, 2] },
      {
        notes: [64, 62, 60, 62, 64, 64, 64, 64, 62, 62, 64, 62, 60],
        beats: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 4],
      },
    ],
  },
  {
    id: 'frere-jacques',
    title: 'Frère Jacques',
    phrases: [
      { notes: [60, 62, 64, 60], beats: [1, 1, 1, 1] },
      { notes: [64, 65, 67], beats: [1, 1, 2] },
      { notes: [67, 69, 67, 65, 64, 60], beats: [0.5, 0.5, 0.5, 0.5, 1, 1] },
      { notes: [60, 55, 60], beats: [1, 1, 2] },
    ],
  },
  {
    id: 'au-clair',
    title: 'Au clair de la lune',
    phrases: [
      { notes: [60, 60, 60, 62, 64, 62], beats: [1, 1, 1, 1, 2, 2] },
      { notes: [60, 64, 62, 62, 60], beats: [1, 1, 1, 1, 4] },
    ],
  },
  {
    id: 'twinkle',
    title: 'Twinkle, Twinkle, Little Star',
    phrases: [
      { notes: [60, 60, 67, 67, 69, 69, 67], beats: [1, 1, 1, 1, 1, 1, 2] },
      { notes: [65, 65, 64, 64, 62, 62, 60], beats: [1, 1, 1, 1, 1, 1, 2] },
      { notes: [67, 67, 65, 65, 64, 64, 62], beats: [1, 1, 1, 1, 1, 1, 2] },
    ],
  },
  {
    id: 'lightly-row',
    title: 'Lightly Row',
    phrases: [
      { notes: [67, 64, 64, 65, 62, 62], beats: [1, 1, 2, 1, 1, 2] },
      { notes: [60, 62, 64, 65, 67, 67, 67], beats: [1, 1, 1, 1, 1, 1, 2] },
    ],
  },
  {
    id: 'ode-to-joy',
    title: 'Ode to Joy',
    phrases: [
      {
        notes: [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62],
        beats: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5, 0.5, 2],
      },
      {
        notes: [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 62, 60, 60],
        beats: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5, 0.5, 2],
      },
    ],
  },
  {
    id: 'london-bridge',
    title: 'London Bridge',
    phrases: [
      { notes: [67, 69, 67, 65, 64, 65, 67], beats: [1.5, 0.5, 1, 1, 1, 1, 2] },
      { notes: [62, 64, 65, 64, 65, 67], beats: [1, 1, 2, 1, 1, 2] },
      {
        notes: [67, 69, 67, 65, 64, 65, 67, 62, 67, 64, 60],
        beats: [1.5, 0.5, 1, 1, 1, 1, 2, 2, 2, 1, 3],
      },
    ],
  },
  {
    id: 'row-your-boat',
    title: 'Row, Row, Row Your Boat',
    phrases: [
      { notes: [60, 60, 60, 62, 64], beats: [1.5, 1.5, 1, 0.5, 1.5] },
      { notes: [64, 62, 64, 65, 67], beats: [1, 0.5, 1, 0.5, 3] },
      {
        notes: [72, 72, 72, 67, 67, 67, 64, 64, 64, 60, 60, 60],
        beats: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
      },
      { notes: [67, 65, 64, 62, 60], beats: [1, 0.5, 1, 0.5, 3] },
    ],
  },
  {
    id: 'jingle-bells',
    title: 'Jingle Bells (chorus)',
    phrases: [
      {
        notes: [64, 64, 64, 64, 64, 64, 64, 67, 60, 62, 64],
        beats: [1, 1, 2, 1, 1, 2, 1, 1, 1.5, 0.5, 4],
      },
      {
        notes: [65, 65, 65, 65, 65, 64, 64, 64, 64, 64, 62, 62, 64, 62, 67],
        beats: [1, 1, 1.5, 0.5, 1, 1, 1, 0.5, 0.5, 1, 1, 1, 1, 2, 2],
      },
    ],
  },
  {
    id: 'saints',
    title: 'When the Saints Go Marching In',
    phrases: [
      { notes: [60, 64, 65, 67], beats: [1, 1, 1, 5] },
      {
        notes: [60, 64, 65, 67, 64, 60, 64, 62],
        beats: [1, 1, 1, 2, 2, 2, 2, 4],
      },
    ],
  },
];

export function tuneById(id: string): Tune | null {
  return TUNES.find((t) => t.id === id) ?? null;
}

export const EASY_TUNES: readonly string[] = [
  'hot-cross-buns',
  'mary',
  'frere-jacques',
  'au-clair',
  'twinkle',
  'lightly-row',
];

export const TUNE_IDS: readonly string[] = TUNES.map((t) => t.id);
