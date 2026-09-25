// 四隅で貼る動画（MapLibre の video source 相当・#49・2026-09-25）＝遅延 chunk。
// 描き方は四隅の画像を「覆う」口（render worker の組み込み imagequad-draw.js・drawImageQuad）と同じ＝動画のコマを ImageBitmap にして
// 毎コマ差し替える（transfer＝コピーなし・前のコマは worker が close）。地面アトラスへの焼き（map.raster.add の { image }）は
// 1 枚ごとにタイルを焼き直す＝毎コマでは重すぎる。ゆえに重ね順は「基図と gint の上・注記の下」の専用オーバーレイ。
// ⚠「紙の遺物を捨てる」原則は維持＝互換の口として受けるだけ（既定の見た目には使わない）。
//
// createVideoQuads({ overlay, maxSide }) → { add(id, { video|urls, corners, opacity }), remove(id), get(id), clear() }
//   video＝HTMLVideoElement（呼び手が持つ）か urls＝[URL…]（ここで <video muted loop playsinline> を作る＝自動再生の許可が要らない形）
//   get(id)＝MapLibre の VideoSource の顔：{ getVideo, play, pause, seek, setCoordinates }
const cornersOk = c => Array.isArray(c) && c.length === 4 && c.every(p => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]));

export function createVideoQuads({ overlay, maxSide = 2048 }) {
	const recs = new Map();   // id → { video, own, corners, opacity, stop }
	let ov = null;
	const ovGet = () => ov ??= overlay();
	function pump(id, rec) {   // コマごと（requestVideoFrameCallback が無い時は rAF＝再生中だけ）に 1 枚送る。前の 1 枚が着く前は重ねて作らない
		let busy = false, alive = true, h = 0;
		const v = rec.video, rvfc = typeof v.requestVideoFrameCallback === "function";
		const next = () => { if (alive) h = rvfc ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(tick); };
		const send = async () => {   // 今のコマを 1 枚
			if (!alive || busy || v.readyState < 2 || !v.videoWidth) return;
			busy = true;
			try {
				const s = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
				const bm = await createImageBitmap(v, s < 1 ? { resizeWidth: Math.round(v.videoWidth * s), resizeHeight: Math.round(v.videoHeight * s) } : undefined);
				if (alive && recs.get(id) === rec) ovGet().post({ type: "set", id, bitmap: bm, corners: rec.corners, opacity: rec.opacity }, [bm]); else bm.close();
			} catch (err) { if (alive) console.warn("[video] frame", id, err?.message || err); }
			busy = false;
		};
		const tick = async () => { await send(); next(); };   // 鎖は 1 本だけ
		// 止まっている間もシーク・読み込みで 1 コマ出す（rVFC は再生中しか呼ばない）＝鎖は増やさない
		const kick = () => { send(); };
		v.addEventListener("seeked", kick); v.addEventListener("loadeddata", kick); v.addEventListener("play", kick);
		next();
		return () => { alive = false; if (rvfc) v.cancelVideoFrameCallback?.(h); else cancelAnimationFrame(h); v.removeEventListener("seeked", kick); v.removeEventListener("loadeddata", kick); v.removeEventListener("play", kick); };
	}
	const api = {
		add(id, { video, urls, corners, opacity = 1 } = {}) {
			if (!cornersOk(corners)) throw new Error("video: corners must be 4 [lon,lat] (top-left, top-right, bottom-right, bottom-left)");
			api.remove(id);
			let own = false;
			if (!video) {
				const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
				if (!list.length) throw new Error("video: urls or video is required");
				video = document.createElement("video");
				Object.assign(video, { muted: true, loop: true, playsInline: true, autoplay: true, crossOrigin: "anonymous", preload: "auto" });
				for (const u of list) { const s = document.createElement("source"); s.src = u; video.appendChild(s); }
				own = true;
			}
			const rec = { video, own, corners: corners.map(p => [+p[0], +p[1]]), opacity };
			recs.set(id, rec);
			rec.stop = pump(id, rec);
			if (own) video.play?.().catch(() => { /* 自動再生の拒否＝利用者の操作後に play() */ });
			return api.get(id);
		},
		remove(id) {
			const rec = recs.get(id); if (!rec) return false;
			recs.delete(id); rec.stop?.();
			if (rec.own) { rec.video.pause(); rec.video.removeAttribute("src"); for (const s of [...rec.video.children]) s.remove(); rec.video.load(); }
			ov?.post({ type: "remove", id });
			return true;
		},
		setOpacity(id, opacity) { const rec = recs.get(id); if (!rec) return false; rec.opacity = opacity; ov?.post({ type: "opacity", id, opacity }); return true; },
		get(id) {
			const rec = recs.get(id); if (!rec) return undefined;
			return {
				getVideo: () => rec.video,
				play: () => rec.video.play(),
				pause: () => rec.video.pause(),
				seek: sec => { rec.video.currentTime = sec; },
				setCoordinates(c) { if (!cornersOk(c)) throw new Error("video: corners must be 4 [lon,lat]"); rec.corners = c.map(p => [+p[0], +p[1]]); ov?.post({ type: "corners", id, corners: rec.corners }); return this; },
				getCoordinates: () => rec.corners.map(p => p.slice()),
			};
		},
		ids: () => [...recs.keys()],
		clear() { for (const id of [...recs.keys()]) api.remove(id); ov?.remove(); ov = null; },
	};
	return api;
}
