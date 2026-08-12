// shared runtime registry — call setup() once in main.js after all functions are defined
export const ctx = {};
export function setup(obj) { Object.assign(ctx, obj); }
