import * as d3 from 'd3';

Object.assign(d3.selection.prototype, {
    dropFiles(func) { return dropFiles(this, func); },
    dropFile(func) { return dropFile(this, func); },
    selectFiles(func) { return selectFiles(this, func); },
    selectFile(func) { return selectFile(this, func); }
});
let saveDire = null;
Object.assign(d3, { download, saveTo });
export {download, saveTo};

async function dropFiles(self, func) {
    return self.on("dragover", e => e.preventDefault()).on("drop", drop);
    async function drop(e) {
        e.preventDefault();
        if (self.property("disabled") || self.attr("disabled")) return;
        const items = Array.from(e.dataTransfer.items || []);
        if (!items.length) return;
        const entries = [];
        const scan = async (entry) => { if (!entry) return;
            if (entry.isFile) { entries.push(entry);
            } else if (entry.isDirectory) {
                const reader = entry.createReader();
                 const readAll = async () => {
                    const results = await new Promise(res => reader.readEntries(res));
                    if (results.length > 0) { await Promise.all(results.map(scan)); await readAll();}
                };
                await readAll();
            }
        };
        await Promise.all(items.map(item => scan(item.webkitGetAsEntry())));
        let files = await Promise.all(entries.map(entry => 
            new Promise(res => entry.file(f => { setFileRelativePath(f, entry); res(f); }))
        ));
        if (typeof func === "function") func(files);
    };
}
function dropFile(self, func) {
    return self.on("dragover", e => e.preventDefault()).on("drop", drop);
    function drop(e) { e.preventDefault();
        self.property("disabled") || self.attr("disabled") || func(e.dataTransfer.files[0]);
    }
}

function selectFiles(self, func) {
    return self.on("click", () => {
        const input = d3.select("body").append("input").attr("type", "file").style("display", "none")
			.attr("webkitdirectory", "").attr("multiple", "")
            .on("change", e => {
                const files = Array.from(e.target.files).map(setFileRelativePath);
				(typeof func === "function") && func(files);
                input.remove();
            });
        input.node().click();
    });
}
function selectFile(self, func) {
    return self.on("click", () => {
        const input = d3.select("body").append("input").attr("type", "file").style("display", "none")
 			.on("change", e => {
                (typeof func === "function") && func(e.target.files[0]);
                input.remove();
            });
        input.node().click();
    });
}

function setFileRelativePath(file, entry)  {
	if (file.webkitRelativePath) return file.webkitRelativePath;
    const path = (entry && entry.fullPath)? entry.fullPath.replace(new RegExp(`${entry.name}$`), "").replace(/^\/|\/$/g, "") : 	"";
    const webkitRelativePath = path ? `${path}/${file.name}` : file.name;
    Object.defineProperty(file, 'webkitRelativePath', {
        value: webkitRelativePath, writable: false, configurable: true, enumerable: true
    });
	return file;
}

function download(blob, name) {
    name = name || blob.name || "download";
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => {URL.revokeObjectURL(url); document.body.removeChild(a);}, 1000);
};

async function saveTo(blob, name) {
	try {
        if (!saveDire) {
            saveDire = await window.showDirectoryPicker({ mode: 'readwrite' });
        } else {
            const status = await saveDire.queryPermission({ mode: 'readwrite' });
            if (status !== 'granted') {
                saveDire = await window.showDirectoryPicker({ mode: 'readwrite' });
            }
        }
        const fileName = name || blob.name || "download";
        const fileHandle = await saveDire.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        console.info(`Saved: ${fileName}`);
        return true;
    } catch (err) {
        if (err.name === 'AbortError') return false;
        saveDire = null;
        console.error("Save failed:", err);
        throw err;
    }
}
