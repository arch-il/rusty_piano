"""Read a MusicXML score with music21 and extract the features used for difficulty.

Features: title and composer from metadata, key and time signature, length in seconds
(from the highest offset and the first tempo marking, default 120 bpm), note count,
pitch range in semitones, chord ratio (chords / single notes plus chords), number of
staves, accidental ratio (pitches with an alteration / all pitches), and whether all
parts are piano.
"""

from dataclasses import dataclass
from pathlib import Path

from music21 import chord, converter, harmony, instrument, key, meter, note, stream, tempo

DEFAULT_BPM = 120.0
PIANO_PROGRAMS = (0, 1, 2, 3)


NOT_FOUND = "file not found"
UNREADABLE = "not a readable MusicXML score"
NO_PARTS = "no notes or parts found in the score"


class AnalysisError(Exception):
    pass


@dataclass
class ScoreAnalysis:
    title: str | None
    composer: str | None
    key: str | None
    time_signature: str | None
    seconds: float | None
    n_notes: int
    pitch_range: int
    chord_ratio: float
    staves: int
    accidental_ratio: float
    piano_only: bool | None


def analyse_file(path) -> ScoreAnalysis:
    if not Path(path).is_file():
        raise AnalysisError(NOT_FOUND)
    try:
        return _analyse(path)
    except AnalysisError:
        raise
    except Exception as exc:
        raise AnalysisError(UNREADABLE) from exc


def _analyse(path) -> ScoreAnalysis:
    try:
        s = converter.parse(str(path), forceSource=True)
    except Exception as exc:
        raise AnalysisError(UNREADABLE) from exc
    if isinstance(s, stream.Opus):
        s = s.scores[0]
    if len(s.parts) == 0:
        raise AnalysisError(NO_PARTS)

    title = s.metadata.bestTitle if s.metadata else None
    composer = s.metadata.composer if s.metadata else None

    singles = 0
    chords = 0
    pitches = []
    for el in s.recurse().getElementsByClass([note.Note, chord.Chord]):
        if isinstance(el, harmony.ChordSymbol):
            continue
        if isinstance(el, chord.Chord):
            chords += 1
            pitches.extend(el.pitches)
        else:
            singles += 1
            pitches.append(el.pitch)

    n_notes = len(pitches)
    midis = [p.midi for p in pitches]
    pitch_range = max(midis) - min(midis) if midis else 0
    chord_ratio = chords / (singles + chords) if chords else 0.0
    accidental_ratio = sum(1 for p in pitches if p.alter != 0) / n_notes if n_notes else 0.0

    ks = s.recurse().getElementsByClass(key.KeySignature).first()
    if isinstance(ks, key.Key):
        k = ks
    elif ks is not None:
        k = s.analyze("key")
        if k.sharps != ks.sharps:
            k = ks.asKey("major")
    elif n_notes:
        k = s.analyze("key")
    else:
        k = None
    key_name = f"{k.tonic.name.replace('-', 'b')} {k.mode}" if k is not None else None

    ts = s.recurse().getElementsByClass(meter.TimeSignature).first()
    time_signature = ts.ratioString if ts is not None else None

    ql = float(s.highestTime)
    mm = s.recurse().getElementsByClass(tempo.MetronomeMark).first()
    bpm = mm.getQuarterBPM() if mm is not None else None
    if bpm is None:
        bpm = DEFAULT_BPM
    seconds = round(ql * 60 / bpm, 1) if ql else None

    insts = [p.getInstrument(returnDefault=False) for p in s.parts]
    if any(inst is None for inst in insts):
        piano_only = None
    else:
        piano_only = all(
            isinstance(inst, instrument.Piano) or getattr(inst, "midiProgram", None) in PIANO_PROGRAMS
            for inst in insts
        )

    return ScoreAnalysis(
        title=title or None,
        composer=composer,
        key=key_name,
        time_signature=time_signature,
        seconds=seconds,
        n_notes=n_notes,
        pitch_range=pitch_range,
        chord_ratio=chord_ratio,
        staves=len(s.parts),
        accidental_ratio=accidental_ratio,
        piano_only=piano_only,
    )
