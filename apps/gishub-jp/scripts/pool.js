export async function pool(items, limit, fn) {
	const queue = [...items];
	let active = 0, idx = 0;
	const results = new Array(items.length);
	return new Promise(resolve => {
		function next() {
			while (active < limit && queue.length) {
				active++;
				const i = idx++, item = queue.shift();
				fn(item, i)
					.then(r => { results[i] = r; })
					.catch(e => { results[i] = { error: e.message }; })
					.finally(() => { active--; next(); });
			}
			if (!active && !queue.length) resolve(results);
		}
		next();
	});
}
