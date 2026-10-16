// sky/theater.js（JS のまま）の型。globe.ts が読む分だけ（TS 化 段 4・batch 3）＝sky/theater.js が TS になれば消える。
/** 星空劇場（z<4）の手綱 */
export interface SkyTheater {
	ensureStars(): void;
	toggleConstellations(): Promise<void>;
	applyConstellations(want: boolean): void;
	solarFrame(w: number, h: number): void;
	terminate(): void;
	timeChanged(): void;
	readonly constelVisible: boolean;
}
export function createSkyTheater(env: object): SkyTheater;
