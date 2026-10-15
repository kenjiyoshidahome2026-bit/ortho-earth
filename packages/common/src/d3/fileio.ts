import * as d3 from 'd3';

// 拡張の this＝HTML 要素のセレクション（d3 の selection.prototype は型が無い（any）＝ここで決める）
type Proto = d3.Selection<HTMLElement, unknown, d3.BaseType, unknown>;

declare module 'd3-selection' {
	interface Selection<GElement extends BaseType, Datum, PElement extends BaseType, PDatum> {
		dropFiles(func?: (files: File[]) => void): Promise<this>;
		dropFile(func: (file: File) => void): this;
		selectFiles(func?: (files: (File | string)[]) => void): this;
		selectFile(func?: (file: File) => void): this;
	}
}

Object.assign(d3.selection.prototype, {
	dropFiles(this: Proto, func?: (files: File[]) => void) { return dropFiles(this, func); },
	dropFile(this: Proto, func: (file: File) => void) { return dropFile(this, func); },
	selectFiles(this: Proto, func?: (files: (File | string)[]) => void) { return selectFiles(this, func); },
	selectFile(this: Proto, func?: (file: File) => void) { return selectFile(this, func); }
});

async function dropFiles(self: Proto, func?: (files: File[]) => void): Promise<Proto> {
	return self.on("drop", drop)
		.on("dragover", (e: DragEvent) => { e.preventDefault(); self.classed("drag-over", true) })
		.on("dragleave", (e: DragEvent) => { e.preventDefault(); self.classed("drag-over", false) });
	async function drop(e: DragEvent): Promise<void> {
		e.preventDefault(); self.classed("drag-over", false);
		if (self.property("disabled") || self.attr("disabled")) return;
		const items = Array.from(e.dataTransfer!.items || []);
		if (!items.length) return;
		const entries: FileSystemFileEntry[] = [];
		const scan = async (entry: FileSystemEntry | null): Promise<void> => { if (!entry) return;
			if (entry.isFile) { entries.push(entry as FileSystemFileEntry);
			} else if (entry.isDirectory) {
				const reader = (entry as FileSystemDirectoryEntry).createReader();
				 const readAll = async (): Promise<void> => {
					const results = await new Promise<FileSystemEntry[]>(res => reader.readEntries(res));
					if (results.length > 0) { await Promise.all(results.map(scan)); await readAll();}
				};
				await readAll();
			}
		};
		await Promise.all(items.map(item => scan(item.webkitGetAsEntry())));
		let files = await Promise.all(entries.map(entry =>
			new Promise<File>(res => entry.file(f => { setFileRelativePath(f, entry); res(f); }))
		));
		if (typeof func === "function") func(files);
	};
}
function dropFile(self: Proto, func: (file: File) => void): Proto {
	return self.on("drop", drop)
		.on("dragover", (e: DragEvent) => { e.preventDefault(); self.classed("drag-over", true) })
		.on("dragleave", (e: DragEvent) => { e.preventDefault(); self.classed("drag-over", false) });
	function drop(e: DragEvent): void {
		e.preventDefault(); self.classed("drag-over", false);
		self.property("disabled") || self.attr("disabled") || func(e.dataTransfer!.files[0]);
	}
}

function selectFiles(self: Proto, func?: (files: (File | string)[]) => void): Proto {
	return self.on("click", () => {
		const input = d3.select("body").append("input").attr("type", "file").style("display", "none")
			.attr("webkitdirectory", "").attr("multiple", "")
			.on("change", (e: Event) => {
				const files = Array.from((e.target as HTMLInputElement).files!).map(f => setFileRelativePath(f));
				(typeof func === "function") && func(files);
				input.remove();
			});
		input.node()!.click();
	});
}
function selectFile(self: Proto, func?: (file: File) => void): Proto {
	return self.on("click", () => {
		const input = d3.select("body").append("input").attr("type", "file").style("display", "none")
 			.on("change", (e: Event) => {
				(typeof func === "function") && func((e.target as HTMLInputElement).files![0]);
				input.remove();
			});
		input.node()!.click();
	});
}

// TODO(ts): webkitRelativePath が既に付いている File では「その文字列」を返す（File でなく）＝selectFiles（webkitdirectory）は func に文字列の配列を渡す。動作は据え置き
function setFileRelativePath(file: File, entry?: FileSystemEntry): string | File  {
	if (file.webkitRelativePath) return file.webkitRelativePath;
	const path = (entry && entry.fullPath)? entry.fullPath.replace(new RegExp(`${entry.name}$`), "").replace(/^\/|\/$/g, "") : 	"";
	const webkitRelativePath = path ? `${path}/${file.name}` : file.name;
	Object.defineProperty(file, 'webkitRelativePath', {
		value: webkitRelativePath, writable: false, configurable: true, enumerable: true
	});
	return file;
}
