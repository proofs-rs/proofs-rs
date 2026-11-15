use creusot_std::prelude::*;

#[requires(x@ < u32::MAX@)]
#[ensures(result@ == x@ + 1)]
pub fn add_one(x: u32) -> u32 {
    x + 1
}

#[requires(x@ < u32::MAX@)]
#[ensures((^x)@ == (*x)@ + 1)]
pub fn increment(x: &mut u32) {
    *x += 1;
}

#[ensures(result == x)]
pub fn identity(x: u32) -> u32 {
    x
}
