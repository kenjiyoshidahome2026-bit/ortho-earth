// request.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝request.js が TS になれば消える。
import type { queryTiles } from "@ortho-earth/core";
import type { ProtocolLoader, ResourceType, TransformRequestFunction } from "../globe.d.ts";

/** requester.fetch の答え＝fetch の Response か、独自スキームの読み口の Response 風（ok／status／json／text／arrayBuffer／blob） */
export interface ResponseLike { ok: boolean; status: number; url?: string; headers?: Headers; json(): Promise<unknown>; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>; blob(): Promise<Blob> }
/** url を手入れした結果（load＝独自スキームの読み口） */
export interface ResolvedRequest { url: string; headers: Record<string, string> | undefined; credentials: RequestCredentials | undefined; load?(want?: "arrayBuffer" | "json" | "image" | "string", ac?: AbortController): Promise<unknown> }
export interface Requester {
	setTransform(fn: TransformRequestFunction | null): void;
	readonly transform: TransformRequestFunction | null;
	resolve(url: string, type?: ResourceType): ResolvedRequest;
	fetch(url: string, type?: ResourceType, init?: RequestInit): Promise<Response | ResponseLike>;
	/** タイルの手入れ（core の queryTiles／pipeline の request の形＝種類の名前は core が渡す・手入れが何も無い間は null を返す） */
	forTiles(): NonNullable<Parameters<typeof queryTiles>[0]["request"]>;
}
export function addProtocol(scheme: string, loader: ProtocolLoader): void;
export function removeProtocol(scheme: string): void;
export function createRequester(): Requester;
