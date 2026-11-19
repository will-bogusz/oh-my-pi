//! Prototype stage timing (WaylandSpine measurement only, not for upstream):
//! with `OMP_DESKTOP_STAGES` set, every timed stage writes its duration to
//! stderr when it ends.

use std::{sync::LazyLock, time::Instant};

static ENABLED: LazyLock<bool> = LazyLock::new(|| std::env::var_os("OMP_DESKTOP_STAGES").is_some());

/// Times the scope it lives in: `let _stage = Stage::start("name");`.
pub(crate) struct Stage(&'static str, Instant);

impl Stage {
	pub(crate) fn start(name: &'static str) -> Self {
		Self(name, Instant::now())
	}
}

impl Drop for Stage {
	fn drop(&mut self) {
		if *ENABLED {
			eprintln!("omp-stage {} {:.2}", self.0, self.1.elapsed().as_secs_f64() * 1000.0);
		}
	}
}
