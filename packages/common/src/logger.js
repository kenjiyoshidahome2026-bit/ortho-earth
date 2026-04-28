const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;
export class Logger {
	constructor() {	this.time = 0;}
	log() { isNode? console.log((""+arguments[0]).replace(/%c/g, '')): console.log(...arguments); }
	pbf(msg) { this.log(`%c📥 [PBF]%c ${msg}`, 'color: #3498db; font-weight: bold;','color: inherit;'); }
	info(msg) { this.log(`%c🔔 [INFO]%c ${msg}`, 'color: #3498db; font-weight: bold;','color: inherit;'); }
	warn(msg) { this.log(`%c⚠️ [WARN]%c ${msg}`, 'color: #f1c40f; font-weight: bold;','color: inherit;'); }
	error(msg) { this.log(`%c❌ [ERROR]%c ${msg}`, 'color: #e74c3c; font-weight: bold;','color: inherit;') }
	data(label, count) { this.log(`%c⚓️ [DATA] %c${label}: %c${count.toLocaleString()}%c`, 'color: #e67e22; font-weight: bold;', 'color: inherit;', 'font-weight: bold;', 'font-weight: 400;');}
	title(message) { this.time = performance.now();
		console.clear();
		this.log(`%c ✨ ${message.toUpperCase()} ✨ `, 'background: #2c3e50; color: #ecf0f1; padding: 2px 10px; border-radius: 5px; font-size: 1.2em;');
	}
	success(msg) { const meas = (performance.now() - this.time).toFixed(2); this.time = performance.now();
		this.log(`%c✅ [SUCCESS] %c${msg} in %c${meas}%c [msec]`,'color: #2ecc71; font-weight: bold;', 'color: inherit;', 'color: #00FFFF; font-weight: bold;', 'color: inherit;');
	}
	progress(current, total) {
		const percent = Math.min(100, Math.round((current / total) * 100));
		const bar = "▓".repeat(Math.floor(percent / 5)) + "░".repeat(20 - Math.floor(percent / 5));
		this.log(`⏳ Processing: [${bar}] ${percent}% (${current.toLocaleString()}/${total.toLocaleString()})`);
	}
	async measure(label, fn) {
		const start = performance.now();
		const result = await fn();
		const meas = (performance.now() - start).toFixed(2);
		this.log(`%c⏱️ [PERF] %c${label} completed in %c${meas}%c [msec]`,'color: #00FFFF; font-weight: bold;', 'color: inherit;', 'color: #00FFFF; font-weight: bold;', 'color: inherit;');
	   return result;
	}
}