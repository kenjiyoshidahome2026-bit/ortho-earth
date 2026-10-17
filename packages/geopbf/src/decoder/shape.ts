import { GeoPBFBase } from "../pbf-base.ts";
import { dissolve } from "../extension/dissolve.ts";
import { decodeZIP } from "../modules/decodeZIP.ts";
import { SHP, DBF, dbfEncoding, shpTransform } from "./shapefile.ts";   // 読み手の芯（Node の手元バッチと共有・2026-10-17）
import type { DecodeRequest, DecodeResponse } from "../worker-msg.ts";

onmessage = async (e: MessageEvent<DecodeRequest>) => {
	try {
		const { file, encoding, precision, shpTarget, crs: crsOpt } = e.data;   // crs＝.prj が無い時の指定（EPSG 番号か WKT。例 6673＝JGD2011 平面直角 V 系）
		const name = file.name.replace(/\.[^\.]+$/, "");
		let entries = await decodeZIP(file);
		if (!entries) { postMessage(null); return; }
		// zip の中の zip を開く（二段まで）＝自治体の地番図は「地番.zip」「筆界.zip」を束ねた zip で配られることがある（長与町 BODIK 等）
		for (let depth = 0; depth < 2 && entries.some(t => /\.zip$/i.test(t.name)); depth++) {
			const next: File[] = [];
			for (const t of entries) {
				if (!/\.zip$/i.test(t.name)) { next.push(t); continue; }
				const inner = await decodeZIP(new File([await t.arrayBuffer()], t.name)).catch(() => null);
				if (inner) next.push(...inner.map(u => Object.defineProperty(u, "name", { value: t.name.replace(/\.zip$/i, "") + "/" + u.name })));
			}
			entries = next;
		}
		const keySet = new Set<string>();
		const shpFiles = shpTarget
			? entries.filter(t => t.name.endsWith(shpTarget))
			: entries.filter(t => t.name.match(/\.shp$/i));
		let warning: string | null = null;
		const dbs = await Promise.all(shpFiles.map(async (f): Promise<[SHP, DBF] | null> => {
			const base = f.name.replace(/\.shp$/i, "");
			// 拡張子の大小を問わない（自治体の地番図は ABIKO_AN.SHP / .DBF / .PRJ のような大文字が多い＝旧は .dbf しか探さず 0 件）
			const sib = (ext: string): File | undefined => entries!.find(t => t.name.toLowerCase() === (base + ext).toLowerCase());
			const dbfFile = sib(".dbf");
			const cpgFile = sib(".cpg");
			const prjFile = sib(".prj");
			if (!dbfFile) return null;
			const shpBuf = new Uint8Array(await f.arrayBuffer());
			const dbfBuf = new Uint8Array(await dbfFile.arrayBuffer());
			const dbf = new DBF(dbfBuf, dbfEncoding(dbfBuf, cpgFile ? await cpgFile.text() : null, encoding));
			dbf.fields.forEach(field => keySet.add(field.name));
			// 座標系：.prj（無ければ opts.crs）を proj.js で判定＝経緯度はそのまま・平面直角/UTM/Web メルカトル/日本測地系は経緯度へ
			const xf = shpTransform(prjFile ? await prjFile.text() : null, crsOpt as number | string | undefined);
			if (xf.warning) warning = xf.warning;
			return [new SHP(shpBuf, xf.transform), dbf];
		}));
		const pbf = new GeoPBFBase({ name, precision });
		pbf.setHead(Array.from(keySet).sort());
		pbf.setBody(() => {
			dbs.filter((t): t is [SHP, DBF] => !!t).forEach(([shp, dbf]) => {
				while (1) {
					const s = shp.read();
					if (s === undefined) break;
					const d = dbf.read();
					if (!d) break;
					if (s) pbf.setFeature({ type: "Feature", geometry: s, properties: d });   // 形の無いレコードは落とす（DBF は進めた）
				}
			});
		});
		pbf.close();
		await pbf.getPosition();
		await dissolve(pbf);
		const res = pbf.arrayBuffer;
		const msg: DecodeResponse = { type: "shpdec", data: res, warning: warning ?? undefined };
		postMessage(msg, [res]);
	} catch (err) {
		console.error("[shape decoder]", err);
		postMessage(null);
	}
};
