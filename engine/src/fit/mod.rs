//! Fitting the modal profile to reference renders (M6); reference WAVs are only read to derive numbers; no audio is ever copied, written or embedded.

pub mod analysis;
pub mod eq_fit;
pub mod evaluate;
pub mod fitter;
pub mod halo;
pub mod reference;
pub mod ron_edit;
