//! Optional per-note adjustment table: anchors are interpolated linearly in note number and held flat outside the first and last anchor;
//! empty = no change. Written by hand or by the fitting tool (M6).

pub const MAX_NOTE_ANCHORS: usize = 88;

fn one() -> f32 {
    1.0
}

/// Adjustments at one anchor note. Multipliers: 1.0 = no change.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteAnchor {
    /// MIDI note of the anchor, 21 - 108.
    pub note: u8,
    /// Pitch offset in cents, added after the stretch tuning.
    #[serde(default)]
    pub cents: f32,
    /// Level trim in dB.
    #[serde(default)]
    pub level_db: f32,
    /// Multiplier of the fundamental decay time.
    #[serde(default = "one")]
    pub t60: f32,
    /// Multiplier of the extra loss per kHz squared (damping_per_khz2).
    #[serde(default = "one")]
    pub damping: f32,
    /// Multiplier of the stiffness inharmonicity B.
    #[serde(default = "one")]
    pub inharmonicity: f32,
    /// Multiplier of the felt force at 1 mm.
    #[serde(default = "one")]
    pub hardness: f32,
    /// Multiplier of the hammer mass.
    #[serde(default = "one")]
    pub hammer_mass: f32,
    /// Multiplier of the strike position.
    #[serde(default = "one")]
    pub strike: f32,
    /// Multiplier of the unison detune.
    #[serde(default = "one")]
    pub detune: f32,
    /// Multiplier of the damper decay time.
    #[serde(default = "one")]
    pub damper: f32,
    /// Multiplier of the share of the decay that stays in the string (1 - soundboard.coupling_loss_fraction); below 1 = longer aftersound, above 1 = shorter.
    #[serde(default = "one")]
    pub aftersound: f32,
    /// Extra decay of the prompt part in dB per second; 0.0 = no prompt part.
    #[serde(default)]
    pub prompt_db_per_s: f32,
    /// Level of the aftersound part relative to the start in dB, -60..0; 0.0 = single decay; the aftersound decays with the t60 table.
    #[serde(default)]
    pub after_level_db: f32,
}

impl NoteAnchor {
    pub const fn neutral(note: u8) -> NoteAnchor {
        NoteAnchor {
            note,
            cents: 0.0,
            level_db: 0.0,
            t60: 1.0,
            damping: 1.0,
            inharmonicity: 1.0,
            hardness: 1.0,
            hammer_mass: 1.0,
            strike: 1.0,
            detune: 1.0,
            damper: 1.0,
            aftersound: 1.0,
            prompt_db_per_s: 0.0,
            after_level_db: 0.0,
        }
    }
}

/// A fixed array so ModalProfile stays Copy and allocation-free; the Vec exists only while parsing.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(try_from = "Vec<NoteAnchor>")]
pub struct NoteTable {
    len: usize,
    anchors: [NoteAnchor; MAX_NOTE_ANCHORS],
}

impl Default for NoteTable {
    fn default() -> Self {
        Self { len: 0, anchors: [NoteAnchor::neutral(0); MAX_NOTE_ANCHORS] }
    }
}

impl TryFrom<Vec<NoteAnchor>> for NoteTable {
    type Error = String;

    fn try_from(v: Vec<NoteAnchor>) -> Result<Self, String> {
        NoteTable::from_anchors(&v)
    }
}

impl NoteTable {
    pub fn from_anchors(a: &[NoteAnchor]) -> Result<NoteTable, String> {
        if a.len() > MAX_NOTE_ANCHORS {
            return Err(format!("notes: at most {MAX_NOTE_ANCHORS} anchor notes, got {}", a.len()));
        }
        let mut t = NoteTable::default();
        t.anchors[..a.len()].copy_from_slice(a);
        t.len = a.len();
        Ok(t)
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn anchors(&self) -> &[NoteAnchor] {
        &self.anchors[..self.len]
    }

    /// Interpolated adjustments for a note; the returned note field is `note`.
    pub fn at(&self, note: u8) -> NoteAnchor {
        let a = self.anchors();
        let (first, last) = match (a.first(), a.last()) {
            (Some(f), Some(l)) => (f, l),
            _ => return NoteAnchor::neutral(note),
        };
        if note <= first.note {
            return NoteAnchor { note, ..*first };
        }
        if note >= last.note {
            return NoteAnchor { note, ..*last };
        }
        for w in a.windows(2) {
            let (x, y) = (&w[0], &w[1]);
            if note <= y.note {
                let span = y.note.saturating_sub(x.note);
                let t = if span == 0 { 1.0 } else { (note - x.note) as f32 / span as f32 };
                let m = |p: f32, q: f32| p + (q - p) * t;
                return NoteAnchor {
                    note,
                    cents: m(x.cents, y.cents),
                    level_db: m(x.level_db, y.level_db),
                    t60: m(x.t60, y.t60),
                    damping: m(x.damping, y.damping),
                    inharmonicity: m(x.inharmonicity, y.inharmonicity),
                    hardness: m(x.hardness, y.hardness),
                    hammer_mass: m(x.hammer_mass, y.hammer_mass),
                    strike: m(x.strike, y.strike),
                    detune: m(x.detune, y.detune),
                    damper: m(x.damper, y.damper),
                    aftersound: m(x.aftersound, y.aftersound),
                    prompt_db_per_s: m(x.prompt_db_per_s, y.prompt_db_per_s),
                    after_level_db: m(x.after_level_db, y.after_level_db),
                };
            }
        }
        NoteAnchor { note, ..*last }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_table_is_neutral() {
        let t = NoteTable::default();
        for n in 21..=108u8 {
            assert_eq!(t.at(n), NoteAnchor::neutral(n));
        }
    }

    #[test]
    fn two_stage_fields_interpolate() {
        let a = NoteAnchor { prompt_db_per_s: 10.0, after_level_db: -20.0, ..NoteAnchor::neutral(30) };
        let b = NoteAnchor { prompt_db_per_s: 30.0, after_level_db: -10.0, ..NoteAnchor::neutral(90) };
        let t = NoteTable::from_anchors(&[a, b]).unwrap();
        assert!((t.at(60).prompt_db_per_s - 20.0).abs() < 1e-5);
        assert!((t.at(60).after_level_db + 15.0).abs() < 1e-5);
        assert_eq!(t.at(21).prompt_db_per_s, 10.0);
        assert_eq!(t.at(108).after_level_db, -10.0);
    }

    #[test]
    fn anchors_interpolate_linearly() {
        let a = NoteAnchor { t60: 2.0, ..NoteAnchor::neutral(30) };
        let b = NoteAnchor { t60: 0.5, cents: 6.0, ..NoteAnchor::neutral(90) };
        let t = NoteTable::from_anchors(&[a, b]).unwrap();
        assert_eq!(t.at(30).t60, 2.0);
        assert_eq!(t.at(21).t60, 2.0);
        assert_eq!(t.at(108).t60, 0.5);
        assert!((t.at(60).t60 - 1.25).abs() < 1e-6);
        assert!((t.at(60).cents - 3.0).abs() < 1e-6);
        assert_eq!(t.at(60).level_db, 0.0);
        let one = NoteTable::from_anchors(&[b]).unwrap();
        for n in 21..=108u8 {
            assert_eq!(one.at(n).t60, 0.5);
            assert_eq!(one.at(n).cents, 6.0);
        }
        let dup = NoteTable::from_anchors(&[a, NoteAnchor { t60: 3.0, ..NoteAnchor::neutral(30) }, b]).unwrap();
        assert!(dup.at(30).t60.is_finite());
        assert!(dup.at(31).t60.is_finite());
    }

    #[test]
    fn aftersound_interpolates() {
        let a = NoteAnchor { aftersound: 0.5, ..NoteAnchor::neutral(30) };
        let b = NoteAnchor { aftersound: 2.0, ..NoteAnchor::neutral(90) };
        let t = NoteTable::from_anchors(&[a, b]).unwrap();
        assert!((t.at(60).aftersound - 1.25).abs() < 1e-6);
        assert_eq!(t.at(21).aftersound, 0.5);
        assert_eq!(t.at(108).aftersound, 2.0);
        assert_eq!(NoteAnchor::neutral(60).aftersound, 1.0);
    }

    #[test]
    fn too_many_anchors_is_an_error() {
        let many: Vec<NoteAnchor> = (0..89).map(|i| NoteAnchor::neutral(21 + i as u8)).collect();
        assert!(NoteTable::from_anchors(&many).unwrap_err().contains("at most 88"));
        let t = NoteTable::from_anchors(&many[..88]).unwrap();
        assert_eq!(t.len(), 88);
    }
}
