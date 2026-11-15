//! Sympathetic resonance of strings that are not being played.
//!
//! Every key 21-108 has one CoupledModes bank: its strings' lowest partials, with the same passive rotation-form resonators and
//! gyrator bridge port as a voice's coupled modes, never driven by a hammer. A key takes part while the board runs and its strings
//! are free (no active voice on it, and a damper amount below 1 or no damper), or while it still rings after its damper came down;
//! it is cleared when culled. Keys join the per-sample delay-free bridge solve exactly like voices, so the whole system stays passive.
//!
//! For speed, the modes of all processed keys are packed into shared 8-lane chunks at the start of each sub-block (each key's
//! pending bridge input is applied as it is packed) and written back to their keys at its end; the arithmetic per mode is the same.

use super::coupling::{CoupledModes, MAX_COUPLED};
use super::profile::ModalProfile;
use super::soundboard::MobilityTable;
use super::strings::{string_set, LANES};

pub const KEYS: usize = 88;
const LOWEST: u8 = 21;
const CHUNKS: usize = (KEYS * MAX_COUPLED).div_ceil(LANES);

type Lanes = [f32; LANES];

pub struct ResonanceBank {
    keys: Vec<CoupledModes>,
    xr: Vec<Lanes>,
    xi: Vec<Lanes>,
    rc: Vec<Lanes>,
    rs: Vec<Lanes>,
    sk: Vec<Lanes>,
    kg: Vec<Lanes>,
    ol: Vec<Lanes>,
    or: Vec<Lanes>,
    ob: Vec<Lanes>,
    pk: Vec<Lanes>,
    wmax: Vec<f32>,
    start: [u16; KEYS],
    nc: usize,
    vb: f32,
    gl: [f32; KEYS],
    gr: [f32; KEYS],
    tilt: [f32; KEYS],
    damping: [f32; KEYS],
    undamped: [bool; KEYS],
    voiced: [bool; KEYS],
    ringing: [bool; KEYS],
    act: [u8; KEYS],
    na: usize,
    gs: f32,
    peak: [f32; KEYS],
    quiet: [u32; KEYS],
    enabled: bool,
}

impl Default for ResonanceBank {
    fn default() -> Self {
        Self::new()
    }
}

fn key_of(note: u8) -> Option<usize> {
    if (LOWEST..LOWEST + KEYS as u8).contains(&note) {
        Some((note - LOWEST) as usize)
    } else {
        None
    }
}

impl ResonanceBank {
    pub fn new() -> Self {
        Self {
            keys: (0..KEYS)
                .map(|_| {
                    let mut c = CoupledModes::new();
                    c.set_damping(1.0);
                    c
                })
                .collect(),
            xr: vec![[0.0; LANES]; CHUNKS],
            xi: vec![[0.0; LANES]; CHUNKS],
            rc: vec![[0.0; LANES]; CHUNKS],
            rs: vec![[0.0; LANES]; CHUNKS],
            sk: vec![[0.0; LANES]; CHUNKS],
            kg: vec![[0.0; LANES]; CHUNKS],
            ol: vec![[0.0; LANES]; CHUNKS],
            or: vec![[0.0; LANES]; CHUNKS],
            ob: vec![[0.0; LANES]; CHUNKS],
            pk: vec![[0.0; LANES]; CHUNKS],
            wmax: vec![0.0; KEYS * MAX_COUPLED],
            start: [0; KEYS],
            nc: 0,
            vb: 0.0,
            gl: [0.0; KEYS],
            gr: [0.0; KEYS],
            tilt: [1.0; KEYS],
            damping: [1.0; KEYS],
            undamped: [false; KEYS],
            voiced: [false; KEYS],
            ringing: [false; KEYS],
            act: [0; KEYS],
            na: 0,
            gs: 0.0,
            peak: [0.0; KEYS],
            quiet: [0; KEYS],
            enabled: false,
        }
    }

    pub fn configure(&mut self, p: &ModalProfile, sample_rate: f32, mob: &MobilityTable) {
        self.enabled = p.resonance.strength > 0.0 && p.soundboard.coupling > 0.0;
        let mut sb = p.soundboard;
        sb.coupling = p.soundboard.coupling * p.resonance.strength;
        for k in 0..KEYS {
            let note = LOWEST + k as u8;
            (self.gl[k], self.gr[k], self.tilt[k]) = super::note_gains(note, p);
            let mut s = string_set(note, p, sample_rate);
            s.damper_tail_db = 0.0;
            self.undamped[k] = s.damper_t60_s.is_none();
            if !self.enabled {
                self.clear_key(k);
                continue;
            }
            s.coupled_partials = p.resonance.partials.min(s.partials_per_string);
            s.coupled_max_hz = p.resonance.max_hz.min(s.max_hz);
            self.keys[k].setup(&s, sample_rate, &sb, mob, true);
        }
        if !self.enabled {
            self.na = 0;
            self.nc = 0;
            self.gs = 0.0;
        }
    }

    /// Refreshes only the output gains (for output-only edits).
    pub fn update_gains(&mut self, p: &ModalProfile) {
        for k in 0..KEYS {
            (self.gl[k], self.gr[k], self.tilt[k]) = super::note_gains(LOWEST + k as u8, p);
        }
    }

    /// Damper amount of a key's strings: 0 = free, 1 = damper fully on.
    pub fn set_damping(&mut self, note: u8, amount: f32) {
        let Some(k) = key_of(note) else {
            return;
        };
        self.damping[k] = amount.clamp(0.0, 1.0);
        self.keys[k].set_damping(self.damping[k]);
    }

    fn eligible(&self, k: usize) -> bool {
        self.enabled && !self.voiced[k] && !self.keys[k].is_empty() && (self.undamped[k] || self.damping[k] < 1.0)
    }

    fn clear_key(&mut self, k: usize) {
        self.keys[k].clear();
        self.ringing[k] = false;
        self.peak[k] = 0.0;
        self.quiet[k] = 0;
        self.wmax[k * MAX_COUPLED..(k + 1) * MAX_COUPLED].fill(0.0);
    }

    /// Chooses the keys processed in this sub-block. A joining key has zero state and zero stored bridge input, so it adds no energy.
    pub fn begin_block(&mut self, voiced_notes: &[bool; 128]) {
        for k in 0..KEYS {
            self.voiced[k] = voiced_notes[LOWEST as usize + k];
            if self.voiced[k] && self.ringing[k] {
                // A played key's strings belong to the voice; dropping the small sympathetic state only removes energy.
                self.clear_key(k);
            }
        }
        self.na = 0;
        self.gs = 0.0;
        let mut m = 0usize;
        for k in 0..KEYS {
            if self.ringing[k] || self.eligible(k) {
                self.ringing[k] = true;
                self.act[self.na] = k as u8;
                self.start[self.na] = m as u16;
                self.na += 1;
                self.gs += self.keys[k].gs();
                for i in 0..self.keys[k].len() {
                    let [xr, xi, rc, rs, sk, kr, kg] = self.keys[k].packed_mode(i);
                    let (c, l) = (m / LANES, m % LANES);
                    self.xr[c][l] = xr;
                    self.xi[c][l] = xi;
                    self.rc[c][l] = rc;
                    self.rs[c][l] = rs;
                    self.sk[c][l] = sk;
                    self.kg[c][l] = kg;
                    self.ol[c][l] = kr * self.gl[k];
                    self.or[c][l] = kr * self.gr[k];
                    self.ob[c][l] = kr * self.tilt[k];
                    self.pk[c][l] = self.wmax[k * MAX_COUPLED + i];
                    m += 1;
                }
            }
        }
        while !m.is_multiple_of(LANES) {
            let (c, l) = (m / LANES, m % LANES);
            self.xr[c][l] = 0.0;
            self.xi[c][l] = 0.0;
            self.rc[c][l] = 0.0;
            self.rs[c][l] = 0.0;
            self.sk[c][l] = 0.0;
            self.kg[c][l] = 0.0;
            self.ol[c][l] = 0.0;
            self.or[c][l] = 0.0;
            self.ob[c][l] = 0.0;
            self.pk[c][l] = 0.0;
            m += 1;
        }
        self.nc = m / LANES;
        self.vb = 0.0;
    }

    /// The board is not running: no key is processed.
    pub fn skip_block(&mut self) {
        self.na = 0;
        self.nc = 0;
        self.gs = 0.0;
    }

    /// Bridge admittance load of the processed keys.
    pub fn gs(&self) -> f32 {
        self.gs
    }

    /// One sample of every processed key: adds its direct sound and body drive at t; returns the sum of kg * xr for the bridge solve.
    #[inline]
    pub fn advance(&mut self, t: usize, direct_l: &mut [f32], direct_r: &mut [f32], body: &mut [f32]) -> f32 {
        let vb = self.vb;
        let mut vel = [0.0f32; LANES];
        let mut dl = [0.0f32; LANES];
        let mut dr = [0.0f32; LANES];
        let mut db = [0.0f32; LANES];
        for c in 0..self.nc {
            let (mut xr, mut xi, mut pk) = (self.xr[c], self.xi[c], self.pk[c]);
            let (rc, rs, sk, kg) = (self.rc[c], self.rs[c], self.sk[c], self.kg[c]);
            let (ol, or, ob) = (self.ol[c], self.or[c], self.ob[c]);
            for l in 0..LANES {
                let tr = xr[l] - sk[l] * vb;
                let x = xi[l];
                let nr = rc[l] * tr - rs[l] * x;
                let ni = rs[l] * tr + rc[l] * x;
                xr[l] = nr;
                xi[l] = ni;
                vel[l] += kg[l] * nr;
                dl[l] += ol[l] * ni;
                dr[l] += or[l] * ni;
                db[l] += ob[l] * ni;
                pk[l] = pk[l].max(ni.abs());
            }
            self.xr[c] = xr;
            self.xi[c] = xi;
            self.pk[c] = pk;
        }
        direct_l[t] += dl.iter().sum::<f32>();
        direct_r[t] += dr.iter().sum::<f32>();
        body[t] += db.iter().sum::<f32>();
        vel.iter().sum::<f32>()
    }

    /// Stores this sample's bridge velocity for every processed key.
    #[inline]
    pub fn commit(&mut self, v_b: f32) {
        self.vb = v_b;
    }

    /// Ends a sub-block; on the grid, culls quiet keys that are no longer free and returns the largest key peak of the window (else 0.0).
    /// A key's peak is bounded by the sum over its modes of |kr| * max |xi| * max(gl, gr), at least the peak of its output.
    /// The per-mode max |xi| runs over the whole 64-frame grid window (reset on the grid), so the bound does not depend on how the caller splits the window.
    pub fn end_block(&mut self, on_grid: bool, quiet: f32, quiet_blocks: u32) -> f32 {
        for a in 0..self.na {
            let k = self.act[a] as usize;
            let s = self.start[a] as usize;
            let mut bound = 0.0f32;
            for i in 0..self.keys[k].len() {
                let (c, l) = ((s + i) / LANES, (s + i) % LANES);
                bound += self.ol[c][l].abs().max(self.or[c][l].abs()) * self.pk[c][l];
                self.wmax[k * MAX_COUPLED + i] = self.pk[c][l];
                self.keys[k].store_mode(i, self.xr[c][l], self.xi[c][l]);
            }
            self.peak[k] = bound;
            self.keys[k].commit(0.0, self.vb);
            self.keys[k].flush_tiny();
        }
        if !on_grid {
            return 0.0;
        }
        let mut m = 0.0f32;
        for i in 0..self.na {
            let k = self.act[i] as usize;
            m = m.max(self.peak[k]);
            if !self.eligible(k) {
                if self.peak[k] <= quiet {
                    self.quiet[k] += 1;
                } else {
                    self.quiet[k] = 0;
                }
                if self.quiet[k] >= quiet_blocks {
                    self.keys[k].clear();
                    self.ringing[k] = false;
                    self.quiet[k] = 0;
                }
            }
            self.peak[k] = 0.0;
            self.wmax[k * MAX_COUPLED..(k + 1) * MAX_COUPLED].fill(0.0);
        }
        m
    }

    pub fn clear(&mut self) {
        for k in 0..KEYS {
            if self.ringing[k] {
                self.keys[k].clear();
            }
            self.ringing[k] = false;
            self.peak[k] = 0.0;
            self.quiet[k] = 0;
            self.wmax[k * MAX_COUPLED..(k + 1) * MAX_COUPLED].fill(0.0);
        }
        self.na = 0;
        self.nc = 0;
    }

    /// Energy in joules of the ringing keys.
    pub fn energy(&self) -> f64 {
        (0..KEYS).filter(|&k| self.ringing[k]).map(|k| self.keys[k].energy()).sum()
    }

    /// Energy in joules of one key's strings; 0.0 unless it is ringing.
    pub fn key_energy(&self, note: u8) -> f64 {
        match key_of(note) {
            Some(k) if self.ringing[k] => self.keys[k].energy(),
            _ => 0.0,
        }
    }

    /// Keys processed in the last sub-block.
    pub fn processed(&self) -> usize {
        self.na
    }

    /// Number of modes of one key.
    pub fn key_len(&self, note: u8) -> usize {
        key_of(note).map_or(0, |k| self.keys[k].len())
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sound::modal_piano::soundboard::Soundboard;

    fn bank_for(p: &ModalProfile, rate: f32) -> ResonanceBank {
        let mut board = Soundboard::new(rate);
        board.configure(p, rate);
        let mut b = ResonanceBank::new();
        b.configure(p, rate, &board.mob);
        b
    }

    #[test]
    fn bank_matches_coupled_setup() {
        let p = ModalProfile::default();
        let rate = 48000.0f32;
        let b = bank_for(&p, rate);
        for note in [21u8, 40, 60, 72, 96, 108] {
            let mut s = string_set(note, &p, rate);
            s.coupled_partials = p.resonance.partials.min(s.partials_per_string);
            s.coupled_max_hz = p.resonance.max_hz.min(s.max_hz);
            assert_eq!(b.key_len(note), CoupledModes::count_for(&s), "note {note}");
        }
        assert_eq!(b.key_len(60), 3 * p.resonance.partials);
        assert_eq!(b.key_len(21), p.resonance.partials);
        assert_eq!(b.key_len(108), 0);
    }

    #[test]
    fn strength_zero_disables_bank() {
        let rate = 48000.0f32;
        let mut p = ModalProfile::default();
        p.resonance.strength = 0.0;
        assert!(!bank_for(&p, rate).enabled());
        let mut p = ModalProfile::default();
        p.soundboard.coupling = 0.0;
        assert!(!bank_for(&p, rate).enabled());
        assert!(bank_for(&ModalProfile::default(), rate).enabled());
    }
}
