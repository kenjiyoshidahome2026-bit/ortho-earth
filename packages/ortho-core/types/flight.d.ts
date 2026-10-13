// @ortho-earth/core — 飛行（van Wijk–Nuij の最適経路・三相・中断可）。
import type { CameraPose } from "./camera.js";
export interface FlightTarget { lon: number; lat: number; zoom: number; pitch: number; bearing: number; /** easePlan だけが補間する（fly/glide は今の値のまま） */ roll?: number }
export interface FlightPlan { dur: number; land: number; at(tMs: number): FlightTarget; knots?: number[] }
export interface FlightEnv { viewW: number; maxPitch: number; minZoom: number }
export const shortBearingOf: (b: number) => number;
export function flyPlan(cam0: FlightTarget, env: FlightEnv, lon: number, lat: number, zoom: number, tiltDeg?: number, bearingDeg?: number): FlightPlan;
export function glidePlan(cam0: FlightTarget, env: FlightEnv, lon: number, lat: number, zoom: number, tiltDeg?: number, bearingDeg?: number): FlightPlan;
export function glidePathPlan(cam0: FlightTarget, env: FlightEnv, pts: Partial<FlightTarget>[]): FlightPlan;
export function easePlan(cam0: FlightTarget, env: FlightEnv, target?: Partial<FlightTarget>, duration?: number): FlightPlan;
export interface FlightController {
	flyTo(...args: unknown[]): Promise<void>;
	glideTo(...args: unknown[]): Promise<void>;
	glidePath(...args: unknown[]): Promise<void>;
	easeTo(target: Partial<FlightTarget> & Record<string, unknown>, duration?: number): Promise<void>;
	cancel(): void;
	readonly active: boolean;
	setMaxPitch(v: number): void;
	setMinZoom(v: number): void;
	plan: {
		fly(cam0: FlightTarget | null, lon: number, lat: number, zoom: number, tiltDeg?: number, bearingDeg?: number): FlightPlan;
		glide(cam0: FlightTarget | null, lon: number, lat: number, zoom: number, tiltDeg?: number, bearingDeg?: number): FlightPlan;
		path(cam0: FlightTarget | null, pts: Partial<FlightTarget>[]): FlightPlan;
	};
	[k: string]: unknown;
}
export function createFlight(opts: { cam: CameraPose; viewW: () => number; maxPitch: number; minZoom?: number; onMove: () => void; onFlying?: (on: boolean) => void; now?: () => number; stepMax?: () => number }): FlightController;
