const CHAR_QUOTE = 34;       // "
const CHAR_BACKSLASH = 92;   // \
const CHAR_LBRACE = 123;     // {
const CHAR_RBRACE = 125;     // }
const CHAR_LBRACKET = 91;    // [

const FEAT_BYTES = [34, 102, 101, 97, 116, 117, 114, 101, 115, 34]; // "features"

// Lookup table for bytes of interest. Most bytes map to 0 (ignore), allowing a single comparison to skip them.
const SCAN_TABLE = new Uint8Array(256);
SCAN_TABLE[CHAR_QUOTE] = 1;
SCAN_TABLE[CHAR_BACKSLASH] = 2;
SCAN_TABLE[CHAR_LBRACE] = 3;
SCAN_TABLE[CHAR_RBRACE] = 4;

export const geojson = (file, callback, syncFlag = false) => {
	const decoder = new TextDecoder();
	const chunkSize = 2 * 1024 * 1024; // 2MB (sync path)

	const chunks = [];

	let inFeatures = false;
	let featMatchIdx = 0;

	let braceCount = 0;
	let inString = false;
	let isEscaped = false;

	// scanPos: global position treating the head of the retained chunk list as 0; adjusted after each prune.
	let scanPos = 0;
	let featureStartPos = -1;

	const pruneChunks = (uptoPos) => {
		while (chunks.length > 0 && uptoPos >= chunks[0].length) {
			const removedLen = chunks[0].length;
			uptoPos   -= removedLen;
			scanPos   -= removedLen;
			if (featureStartPos !== -1) featureStartPos -= removedLen;
			chunks.shift();
		}
	};

	const extractJsonString = (start, end) => {
		const c0 = chunks[0];
		// Fast path: after pruning, the most common case is that the feature fits entirely in chunks[0].
		if (end <= c0.length) return decoder.decode(c0.subarray(start, end));
		// Multi-chunk span: concatenate and decode.
		const res = new Uint8Array(end - start);
		let cBase = 0, resOff = 0;
		for (let i = 0; i < chunks.length; i++) {
			const c = chunks[i], cEnd = cBase + c.length;
			if (start < cEnd && end > cBase) {
				const cs = Math.max(0, start - cBase), ce = Math.min(c.length, end - cBase);
				res.set(c.subarray(cs, ce), resOff);
				resOff += ce - cs;
			}
			cBase = cEnd;
			if (cBase >= end) break;
		}
		return decoder.decode(res);
	};

	const findChunk = () => {
		let ci = 0, cBase = 0;
		while (ci < chunks.length && cBase + chunks[ci].length <= scanPos) {
			cBase += chunks[ci].length; ci++;
		}
		return [ci, cBase];
	};

	const processBinary = () => {
		let [ci, cBase] = findChunk();

		// Phase 1: locate the '[' immediately after "features" (once per file).
		if (!inFeatures) {
			outer1: while (ci < chunks.length) {
				const chunk = chunks[ci];
				let lp = scanPos - cBase;
				while (lp < chunk.length) {
					const b = chunk[lp++]; scanPos++;
					if (featMatchIdx < FEAT_BYTES.length) {
						if (b === FEAT_BYTES[featMatchIdx]) { featMatchIdx++; }
						else { featMatchIdx = (b === FEAT_BYTES[0]) ? 1 : 0; }
					} else if (b === CHAR_LBRACKET) {
						inFeatures = true;
						pruneChunks(scanPos); // free the header from memory
						[ci, cBase] = findChunk();
						break outer1;
					}
				}
				cBase += chunk.length; ci++;
			}
			if (!inFeatures) return;
		}

		// Phase 2: extract Feature objects by tracking brace depth.
		// Reference chunks directly (no getByteAt wrapper) to eliminate call overhead.
		while (ci < chunks.length) {
			const chunk = chunks[ci];
			let lp = scanPos - cBase;
			let doRestart = false;

			while (lp < chunk.length) {
				const b = chunk[lp++]; scanPos++;

				if (isEscaped) { isEscaped = false; continue; }

				const code = SCAN_TABLE[b];
				if (code === 0) continue;                        // most bytes: skip with one comparison
				if (code === 2) { isEscaped = true; continue; } // backslash
				if (code === 1) { inString = !inString; continue; } // quote
				if (inString) continue;

				if (code === 3) {                                // lbrace
					if (braceCount++ === 0) featureStartPos = scanPos - 1;
				} else {                                         // rbrace
					if (--braceCount === 0 && featureStartPos !== -1) {
						try { callback(JSON.parse(extractJsonString(featureStartPos, scanPos))); }
						catch (ex) { console.warn("Parse Error:", ex); }
						pruneChunks(scanPos); // release extracted range to GC immediately
						featureStartPos = -1;
						[ci, cBase] = findChunk(); // re-anchor after prune
						doRestart = true;
						break;
					}
				}
			}

			// On restart, do not advance ci/cBase — they were already updated by findChunk().
			if (!doRestart) { cBase += chunk.length; ci++; }
		}
	};

	if (syncFlag) {
		let offset = 0;
		const reader = new FileReaderSync();
		while (offset < file.size) {
			chunks.push(new Uint8Array(reader.readAsArrayBuffer(file.slice(offset, offset + chunkSize))));
			processBinary();
			offset += chunkSize;
		}
	} else {
		return new Promise(async (resolve) => {
			const stream = file.stream().getReader();
			while (true) {
				const { done, value } = await stream.read();
				if (done) break;
				chunks.push(value);
				processBinary();
			}
			resolve();
		});
	}
};
