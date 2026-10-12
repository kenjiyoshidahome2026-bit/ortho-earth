// @ortho-earth/core/fidexpr — gint の式を WGSL へ（WebGPU・opt-in gpuExpr）。
export class Dict { constructor(...args: unknown[]); [k: string]: unknown }
export function paintKeys(paint: Record<string, unknown>): string[];
export function buildPropColumns(...args: unknown[]): unknown;
export function buildStateColumns(...args: unknown[]): unknown;
export function buildGeomColumn(...args: unknown[]): unknown;
export function encodeStateRow(...args: unknown[]): unknown;
export function dictTables(dict: Dict): unknown;
export function compileFidStyleWGSL(paint?: Record<string, unknown>, filter?: unknown, opts?: Record<string, unknown>): { code: string; [k: string]: unknown };
