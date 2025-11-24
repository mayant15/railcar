// SPDX-License-Identifier: AGPL-3.0-or-later

use libafl_bolts::shmem::{MmapShMem, MmapShMemProvider, ShMemDescription, ShMemProvider};
use napi::{Env, JsObject};

use railcar::shmem::ShMemView;

#[macro_use]
extern crate napi_derive;

#[napi]
pub struct SharedExecutionData {
    shmem: MmapShMem,
}

#[napi]
impl SharedExecutionData {
    #[napi(constructor)]
    pub fn new(env: Env, desc: JsObject) -> napi::Result<Self> {
        let desc: ShMemDescription = env.from_js_value(desc)?;
        let mut provider = MmapShMemProvider::new().unwrap();
        let shmem = provider.shmem_from_description(desc).unwrap();
        Ok(Self { shmem })
    }

    #[napi]
    pub fn record_hit(&mut self, edge_id: u32, total: u32) -> napi::Result<()> {
        let edge_id: usize = edge_id.try_into().map_err(|e| {
            napi::Error::from_reason(format!("failed to convert u32 -> usize {}", e))
        })?;

        let data = ShMemView::from_mut(&mut self.shmem);
        data.total_edges = total;

        // set count
        let map = &mut data.coverage;
        let key = edge_id % map.len();
        let hits = map[key];
        let hits = if hits == 255 { 1 } else { hits + 1 };
        map[key] = hits;

        Ok(())
    }

    #[napi]
    pub fn set_valid(&mut self, is_valid: bool) {
        let data = ShMemView::from_mut(&mut self.shmem);
        data.is_valid = is_valid;
    }

    #[napi]
    pub fn set_num_calls_executed(&mut self, num: u32) {
        let data = ShMemView::from_mut(&mut self.shmem);
        data.num_calls_executed = num;
    }
}
