import * as d3 from "d3";
import './main.scss';
import orthoMap from 'ortho-map';
import { createGeopbf } from "geopbf";
import { nativeBucket } from "native-bucket";
//------------------------------------------------------
const API_BASE = "https://api.ortho-earth.com";
const TILER_BASE = "https://tiler.ortho-earth.com";
createGeopbf(API_BASE, { bucket: nativeBucket });
// Section tabs (Demos / Technologies) — client-side; swaps the card panels over the ambient globe.
// Wired early so they respond before the globe finishes loading. #technologies deep-links the Tech tab.
function selectTab(name) {
	d3.selectAll('.tab').each(function () {
		const on = this.dataset.tab === name;
		d3.select(this).classed('is-active', on).attr('aria-selected', on ? 'true' : 'false');
	});
	d3.select('#panel-demos').attr('hidden', name === 'tech' ? 'hidden' : null);
	d3.select('#panel-tech').attr('hidden', name === 'tech' ? null : 'hidden');
}
d3.selectAll('.tab').on('click', function () {
	const name = this.dataset.tab;
	selectTab(name);
	history.replaceState(null, '', name === 'tech' ? '#technologies' : location.pathname);
});
if (location.hash === '#technologies') selectTab('tech');
d3.select(".logo").html(`${await (await fetch("/favicon.svg")).text() }Ortho Earth`);
//------------------------------------------------------
// Ambient auto-rotating globe behind the overlay (background only — no interactive demo mode).
const zoom = Math.log2(Math.min(window.innerWidth, window.innerHeight)/2*0.8 / 256 * Math.PI * 2);
const mapInst = await orthoMap({target:d3.select('#mapContainer'), center:[0,0], zoom, apiUrl: API_BASE, tilerBase: TILER_BASE});
mapInst.autoRotate(true);
