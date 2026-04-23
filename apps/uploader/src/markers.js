import { isArray, isFile } from "common";
import { DOMParser } from 'linkedom';
import { Bucket, Cache } from "native-bucket";

const dire = "GIS/data", bucket = await Bucket(dire), cache = await Cache(dire);
const targetZIP = "Markers.zip", etag = await bucket.etag(targetZIP);
const isURL = _ => (typeof _ == "string") && (_.match(/^https?\:\/\//)||_.match(/^data\:.*\;base64\,/)||_.match(/blob\:/));

const url2bitmap = async(url, w, h) => {
	const img = new Image(); img.src = url;
	await img.decode();
	const canvas = new OffscreenCanvas(w, h);
	canvas.getContext('2d').drawImage(img, 0, 0, img.width, img.height, 0, 0, w,h);
	return createImageBitmap(canvas);
};
const image2bitmap = async(file, w, h) => {
	const url = URL.createObjectURL(file);
	const bitmap = await url2bitmap(url, w, h);
	URL.revokeObjectURL(url);
	return bitmap;
};
const svg2bitmap = async(svg, w, h) => {
	const img = new Image(); img.src = 'data:image/svg+xml,' + encodeURIComponent(addSize(svg, w, h));
	await img.decode();
	return createImageBitmap(img);
	function addSize(svg, w, h) {
		svg = svg.replace(/\<\?.+\?\>/,"");
		const parser = new DOMParser(), serializer = new XMLSerializer();
		const elem = parser.parseFromString(svg, 'image/svg+xml').documentElement;
		elem.setAttribute('xmlns', "http://www.w3.org/2000/svg");
		elem.setAttribute('width', w), elem.setAttribute('height', h);
		w == h || elem.setAttribute('preserveAspectRatio', "none");
		return `<?xml version="1.0" encoding="UTF-8"?>` + serializer.serializeToString(elem);
	}
};
const initialize = async() => {
	if (etag == await cache("__etag__")) return;
	const dt = new Date();
	const files = await bucket.gets(targetZIP);
	await Promise.all(files.map(file=>cache(file.name.replace(/\.svg$/,""), file)));
	await cache("__etag__", etag)
	console.log(`download: Markers.zip (${(new Date() - dt)/1000} sec)`);
};
////---------------------------------------------------------------
export async function fromIMG(file, size) { const self = this;
	const [w,h] = [self.width, self.height] = isArray(size)? size: [size,size];
	if (isFile(file)) {
		if (file.type == "image/svg+xml") self.bitmap = await self.fromSVG(await file.text(), size);
		else if (file.type.match(/^image/)) self.bitmap = await image2bitmap(file, w, h);
	} else if (isURL(file)) self.bitmap = await url2bitmap(file, w, h);
	if (!self.bitmap) console.error(`fail to create bitmap: ${file}`);
	return self.offset(-w/2, -h/2);
}
export async function fromSVG(name, size) { const self = this;
	self.name = name;
	const [w,h] = [self.width, self.height] = isArray(size)? size: [size,size];
	await initialize();
	if (name.toString().match(/\<svg/)) {
		self.bitmap = await svg2bitmap(self.svg = name, w, h);
	} else {
		const file = await cache(name);
		file && (self.bitmap = await svg2bitmap(self.svg = await file.text(), w, h));
	}
	if (!self.bitmap) console.error(`fail to create bitmap: ${name}`);
	return self.offset(-w/2, -h/2);
}
export async function marker(size = 32, fill="#800", stroke="#fff",label=true) { const self = this;
	const svg = `<svg viewBox="26 26 460 460">
		<path fill="${fill}" stroke="${stroke}" stroke-width="20" d="m351,103c-52-52-137-52-190,0c-47,47-53,136-12,190l107,155l107-155c40-53,35-142-12-190z"/>
		${label===true?`<circle cx="256" cy="200" r="50" fill="${stroke}"/>`:`<text font-size="140" font-family="Arial" x="256" y="220" fill="${stroke}" text-anchor="middle" alignment-baseline="middle">${label}</text>`}
	</svg>`;
	await self.fromSVG(svg, size);
	return self.offset(-self.width/2, -self.height);
}
export async function paramSVG(name, size, n, color) { const self = this;
	self.name = name;
	const [w,h] = [self.width, self.height] = isArray(size)? size: [size,size];
	const func_markers = {
	"国道": (n) =>       `<svg viewBox="0 0 455 435"><path fill="#0140ff" stroke="#fff" stroke-width="16" d="m227 425c25 0 48-10 66-26 69-69 120-155 146-249 3-8 5-19 5-30 0-45-31-83-74-94-46-11-92-17-143-17s-97 6-143 17c-43 11-74 49-74 94 0 11 2 21 5 30 26 94 77 180 146 249 18 16 41 26 66 26z"/><g fill="#fff" font-family="sans-serif" text-align="center" text-anchor="middle" style="line-height:130;"><text x="238" y="120" font-size="60px">国　道</text><text transform="scale(0.95 1.05)" x="238" y="323" font-size="45px">ROUTE</text><text transform="scale(0.95 1.05)" x="238" y="250" font-size="125px" style="font-weight:bold;">${(n)}</text></g></svg>`,
	"霊場": (n,color) => `<svg viewBox="0 0 400 400"><defs><filter id="shadowx" x="-100%" y="-100%" width="500%" height="500%"><feGaussianBlur result="out" in="SourceAlpha" stdDeviation="5"/><feBlend in="SourceGraphic" in2="out" mode="normal"/></filter></defs><path fill="${color}" d="m210 24h-3c-22 13-43 28-65 42 4 15 47-5 40 24 12 20-24 34-31 51-15 16-27 35-39 53-9 14 1 32 16 16 9-3 32-27 33-9 1 16-2 32 1 48 17 14 50-8 60 5-8 17 5 38 7 56 5 22 8 44 16 66 18 5 37 0 27-20-8-33-15-66-23-99-3-10-39-6-13-8 23 5 34-8 29-29-3-24 39-16 43-36-1-18-9-40-26-49-21-6-27-31-45-39 5-15 10-30 31-24 18-8-19-20-25-28-12-4-21-19-33-20zm-117 117c-2 0-4 0-5 1-8 17-2 40-4 59 0 57-1 114 1 171 22 17 14-26 16-39 1-62 2-124 1-186 0-4-4-6-9-6zm100 112c-3 0-6 0-11 1-19 8-11 37-20 52-4 22-11 43-15 64 8 12 40 8 36-12 5-23 10-45 15-67 0-15 15-38-5-39z"/><text font-size="150" fill="#fff" x="200" y="220" text-align="center" text-anchor="middle" filter="url(#shadowx)">${n}</text></svg>`,
	"line": (n,color) => `<svg viewBox="0 0 400 400"><path fill="none" stroke="${color}" d="M0 200H400" stroke-width="${n}"/></svg>`,
	"area": (n,color) => `<svg viewBox="0 0 400 400"><path fill="${color}" stroke="${color}" d="M50 50h300v300h-300v-300z" opacity="0.5" stroke-width="${n}"/></svg>`,
	"tend": (n,color) => `<svg viewBox="0 0 400 400"><path fill="${color}" d="${n<0? "m200 40-160 160 80 0 0 160 160 0L280 200l80 0z":n>0? "m200 360-160-160 80 0L120 40l160 0 0 160 80 0z":"M80 80L80 320 320 320 320 80 80 80z"}" stroke="#fff" stroke-width="10"/></svg>`
	};
	if (name in func_markers) {
		self.svg = func_markers[name](n,color);
		self.bitmap = await svg2bitmap(self.svg, w, h);
	}
	if (!self.bitmap) console.error(`fail to create bitmap: ${name}`);
	return self.offset(-w/2, -h/2);
}

export function offset(x,y) { this.offsetX = x, this.offsetY = y; return this; }
export function draw(ctx, [x, y]) { const self = this, {bitmap, width, height, offsetX, offsetY} = self;
	ctx.drawImage(bitmap, (x+offsetX), (y+offsetY));
}
export async function image(name = "undefined", type = "image/webp", quality = 0.8) {
	name = `${name.replace(/\..+$/,"")}.${type.split("/")[1]}`;
	const self = this, {bitmap, width, height} = self;
	const canvas = new OffscreenCanvas(width, height);
	canvas.getContext('2d').drawImage(bitmap, 0, 0);
	const blob = await canvas.convertToBlob({type, quality});
	return new File([blob], name, {type});
}
//	close() { this.bitmap.close(); delete this.bitmap; delete this.svg; return this; }

