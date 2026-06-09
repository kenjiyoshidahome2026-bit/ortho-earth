export function viewTable(self, containerId) {
    const tableData = self.propertiesTable;
    if (!tableData || tableData.length < 1) return "";

    const headers = tableData[0];
    const rows = tableData.slice(1);

    const stringifyValue = (v) => {
        if (v == null) return "";
        if (v instanceof Date) return v.toISOString();
        if (v instanceof Blob) return `[Blob: ${v.name || 'Unnamed'} (${v.type || 'unknown'}, ${v.size}B)]`;
        if (v instanceof ImageData) return `[ImageData: ${v.width}x${v.height}]`;
        if (typeof v === "function") return v.toString();
        if (typeof v === "object") return JSON.stringify(v);
        return String(v);
    };

    const csvContent = tableData.map((row, idx) => row.map(v => `"${stringifyValue(v).replace(/\"/g, '""')}"`).join(",")).join("\n");

    const container = document.getElementById(containerId);
    if (!container) return csvContent;

    if (!document.getElementById("gis-table-style")) {
        const sheet = document.createElement("style");
        sheet.id = "gis-table-style";
        sheet.textContent = `
            .gis-table-wrapper { width: 100%; max-height: 400px; overflow-y: auto; border: 1px solid #ccc; font-family: monospace; font-size: 12px; }
            .gis-table { width: 100%; border-collapse: collapse; text-align: left; }
            .gis-table th { position: sticky; top: 0; background: #f0f0f0; z-index: 1; border-bottom: 2px solid #ccc; padding: 6px 8px; }
            .gis-table td { border-bottom: 1px solid #eee; padding: 6px 8px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .gis-table tr:hover { background: #f9f9f9; }
            .csv-btn { margin-bottom: 8px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
        `;
        document.head.appendChild(sheet);
    }

    let html = `<button class="csv-btn" id="gis-csv-dl">Export CSV</button>`;
    html += `<div class="gis-table-wrapper"><table class="gis-table"><thead><tr>`;
    headers.forEach(h => html += `<th>${h}</th>`);
    html += `</tr></thead><tbody>`;
    rows.forEach(row => {
        html += `<tr>`;
        headers.forEach((_, i) => {
            const displayStr = stringifyValue(row[i]);
            html += `<td title="${displayStr.replace(/"/g, '&quot;')}">${displayStr}</td>`;
        });
        html += `</tr>`;
    });
    html += `</tbody></table></div>`;

    container.innerHTML = html;

    container.querySelector("#gis-csv-dl").onclick = () => {
        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `${self.name() || "attributes"}.csv`;
        link.click();
    };

    return csvContent;
}