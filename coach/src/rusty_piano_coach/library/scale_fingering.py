"""Textbook fingering for the generated scales and arpeggios, written as .fingering.json sidecars."""

from pathlib import Path

from . import fingering, scales

TEXTBOOK_TOOL = "rusty_piano scales table v1"
BLACK = {1, 3, 6, 8, 10}
ARP_TONES = {"arp-major": [0, 4, 7], "arp-minor": [0, 3, 7], "arp-dom7": [0, 4, 7, 10], "arp-dim7": [0, 3, 6, 9]}

MAJOR_FINGERS = {
    0: {"rh": ([1, 2, 3, 1, 2, 3, 4], 1, 5), "lh": ([1, 4, 3, 2, 1, 3, 2], 5, 1)},  # C
    1: {"rh": ([2, 3, 1, 2, 3, 4, 1], 2, 2), "lh": ([3, 2, 1, 4, 3, 2, 1], 3, 3)},  # Db
    2: {"rh": ([1, 2, 3, 1, 2, 3, 4], 1, 5), "lh": ([1, 4, 3, 2, 1, 3, 2], 5, 1)},  # D
    3: {"rh": ([3, 1, 2, 3, 4, 1, 2], 3, 3), "lh": ([3, 2, 1, 4, 3, 2, 1], 3, 3)},  # Eb
    4: {"rh": ([1, 2, 3, 1, 2, 3, 4], 1, 5), "lh": ([1, 4, 3, 2, 1, 3, 2], 5, 1)},  # E
    5: {"rh": ([1, 2, 3, 4, 1, 2, 3], 1, 4), "lh": ([1, 4, 3, 2, 1, 3, 2], 5, 1)},  # F
    6: {"rh": ([2, 3, 4, 1, 2, 3, 1], 2, 2), "lh": ([4, 3, 2, 1, 3, 2, 1], 4, 4)},  # F#
    7: {"rh": ([1, 2, 3, 1, 2, 3, 4], 1, 5), "lh": ([1, 4, 3, 2, 1, 3, 2], 5, 1)},  # G
    8: {"rh": ([3, 4, 1, 2, 3, 1, 2], 3, 3), "lh": ([3, 2, 1, 4, 3, 2, 1], 3, 3)},  # Ab
    9: {"rh": ([1, 2, 3, 1, 2, 3, 4], 1, 5), "lh": ([1, 4, 3, 2, 1, 3, 2], 5, 1)},  # A
    10: {"rh": ([4, 1, 2, 3, 1, 2, 3], 4, 4), "lh": ([3, 2, 1, 4, 3, 2, 1], 3, 3)},  # Bb
    11: {"rh": ([1, 2, 3, 1, 2, 3, 4], 1, 5), "lh": ([1, 3, 2, 1, 4, 3, 2], 4, 1)},  # B
}
MINOR_FINGERS = {  # harmonic minor; natural and melodic use it with the overrides below
    0: {"rh": ([1, 2, 3, 1, 2, 3, 4], 1, 5), "lh": ([1, 4, 3, 2, 1, 3, 2], 5, 1)},  # C
    1: {"rh": ([3, 4, 1, 2, 3, 1, 2], 3, 3), "lh": ([3, 2, 1, 4, 3, 2, 1], 3, 3)},  # C#
    2: {"rh": ([1, 2, 3, 1, 2, 3, 4], 1, 5), "lh": ([1, 4, 3, 2, 1, 3, 2], 5, 1)},  # D
    3: {"rh": ([3, 1, 2, 3, 4, 1, 2], 3, 3), "lh": ([2, 1, 4, 3, 2, 1, 3], 2, 2)},  # Eb
    4: {"rh": ([1, 2, 3, 1, 2, 3, 4], 1, 5), "lh": ([1, 4, 3, 2, 1, 3, 2], 5, 1)},  # E
    5: {"rh": ([1, 2, 3, 4, 1, 2, 3], 1, 4), "lh": ([1, 4, 3, 2, 1, 3, 2], 5, 1)},  # F
    6: {"rh": ([3, 4, 1, 2, 3, 1, 2], 3, 3), "lh": ([4, 3, 2, 1, 3, 2, 1], 4, 4)},  # F#
    7: {"rh": ([1, 2, 3, 1, 2, 3, 4], 1, 5), "lh": ([1, 4, 3, 2, 1, 3, 2], 5, 1)},  # G
    8: {"rh": ([3, 4, 1, 2, 3, 1, 2], 3, 3), "lh": ([3, 2, 1, 4, 3, 2, 1], 3, 3)},  # G#
    9: {"rh": ([1, 2, 3, 1, 2, 3, 4], 1, 5), "lh": ([1, 4, 3, 2, 1, 3, 2], 5, 1)},  # A
    10: {"rh": ([4, 1, 2, 3, 1, 2, 3], 4, 4), "lh": ([2, 1, 3, 2, 1, 4, 3], 2, 2)},  # Bb
    11: {"rh": ([1, 2, 3, 1, 2, 3, 4], 1, 5), "lh": ([1, 3, 2, 1, 4, 3, 2], 4, 1)},  # B
}
NATURAL_CYCLE_OVERRIDE = {(8, "lh"): [3, 2, 1, 3, 2, 1, 4]}  # G# natural minor LH: the harmonic cycle would put the thumb on F#
MELODIC_UP_OVERRIDE = {(1, "rh"): ([2, 3, 1, 2, 3, 4, 1], 2), (6, "rh"): ([2, 3, 1, 2, 3, 4, 1], 2)}  # C# and F# melodic minor RH going up: (cycle, bottom)
ARP_FINGERS = {
    "arp-major": [((0, 2, 4, 5, 7, 9, 11, 6), {"rh": ([1, 2, 3], 1, 5), "lh": ([1, 4, 2], 5, 1)}),
                  ((1, 3, 8), {"rh": ([4, 1, 2], 2, 4), "lh": ([2, 1, 4], 2, 2)}),
                  ((10,), {"rh": ([4, 1, 2], 2, 4), "lh": ([3, 2, 1], 3, 3)})],
    "arp-minor": [((0, 2, 4, 5, 7, 9, 11, 3), {"rh": ([1, 2, 3], 1, 5), "lh": ([1, 4, 2], 5, 1)}),
                  ((1, 6, 8), {"rh": ([4, 1, 2], 2, 4), "lh": ([2, 1, 4], 2, 2)}),
                  ((10,), {"rh": ([2, 3, 1], 2, 4), "lh": ([3, 2, 1], 3, 3)})],
    "arp-dom7": [((0, 2, 4, 5, 7, 9, 11), {"rh": ([1, 2, 3, 4], 1, 5), "lh": ([1, 4, 3, 2], 5, 1)}),
                 ((1, 3, 8), {"rh": ([4, 1, 2, 3], 2, 4), "lh": ([2, 1, 4, 3], 2, 2)}),
                 ((6,), {"rh": ([2, 3, 4, 1], 2, 2), "lh": ([4, 3, 2, 1], 4, 2)}),
                 ((10,), {"rh": ([4, 1, 2, 3], 2, 4), "lh": ([3, 2, 1, 4], 3, 3)})],
    "arp-dim7": [((0, 2, 4, 5, 7, 9, 11), {"rh": ([1, 2, 3, 4], 1, 5), "lh": ([1, 4, 3, 2], 5, 1)}),
                 ((1, 6, 8), {"rh": ([4, 1, 2, 3], 2, 4), "lh": ([3, 2, 1, 4], 3, 3)}),
                 ((3, 10), {"rh": ([3, 4, 1, 2], 3, 3), "lh": ([3, 2, 1, 4], 3, 3)})],
}


def _chromatic(hand, notes):
    last = len(notes) - 1
    out = []
    for i, n in enumerate(notes):
        pc = n.midi % 12
        if pc in BLACK:
            out.append(3)
        elif hand == "rh":
            if pc in (0, 5):
                out.append(1 if i in (0, last) else 2)
            else:
                out.append(1)
        else:
            out.append(2 if pc in (4, 11) else 1)
    return out


def fingers(sc, hand, notes) -> list[int]:
    if sc.kind == "chromatic":
        return _chromatic(hand, notes)
    n = sc.octaves
    last = len(notes) - 1
    if sc.kind.startswith("arp-"):
        k = len(ARP_TONES[sc.kind])
        row = next(r for pcs, r in ARP_FINGERS[sc.kind] if sc.pc in pcs)[hand]
        cycle, bottom, top_finger = row
        top = k * n
        tones = ARP_TONES[sc.kind]
        out = []
        for i, note in enumerate(notes):
            if i == 0 or i == last:
                out.append(bottom)
            elif i == top:
                out.append(top_finger)
            else:
                out.append(cycle[tones.index((note.midi - notes[0].midi) % 12)])
        return out
    top = 7 * n
    if sc.kind == "major":
        cycle, bottom, top_finger = MAJOR_FINGERS[sc.pc][hand]
    else:
        cycle, bottom, top_finger = MINOR_FINGERS[sc.pc][hand]
    up_cycle = down_cycle = cycle
    nat = NATURAL_CYCLE_OVERRIDE.get((sc.pc, hand), cycle)
    if sc.kind == "minor-natural":
        up_cycle = down_cycle = nat
    elif sc.kind == "minor-melodic":
        down_cycle = nat
        if (sc.pc, hand) in MELODIC_UP_OVERRIDE:
            up_cycle, bottom = MELODIC_UP_OVERRIDE[(sc.pc, hand)]
    tonic_index = scales.LETTERS.index(sc.tonic[0])
    out = []
    for i, note in enumerate(notes):
        degree = (scales.LETTERS.index(note.step) - tonic_index) % 7
        if i == 0 or i == last:
            out.append(bottom)
        elif i == top:
            out.append(top_finger)
        elif i < top:
            out.append(up_cycle[degree])
        else:
            out.append(down_cycle[degree])
    return out


def scale_notes(sc) -> list[dict]:
    hands = scales._hands(sc)
    _, _, starts, _ = scales._timing(len(hands[0][1]), sc.octaves)
    items = []
    for staff, notes in hands:
        hand = "rh" if staff == 1 else "lh"
        fs = fingers(sc, hand, notes)
        for j, note in enumerate(notes):
            items.append({"m": starts[j] // 16, "q": (starts[j] % 16) / 4, "s": staff - 1, "p": note.midi,
                          "f": str(fs[j])})
    items.sort(key=lambda x: (x["m"], x["q"], x["s"], x["p"]))
    return items


def write_scale_sidecar(sc, score_path: Path) -> Path:
    return fingering.write_sidecar(score_path, source="textbook", tool=TEXTBOOK_TOOL, notes=scale_notes(sc))
