import * as d3 from 'd3';
import './loader.scss';
d3.selection.prototype.loader = function(opts = {}) { const size = opts.size||100;
    const canvas = this.prepend("canvas").classed("loader", true).attr("width", size).attr("height", size).node();
    opts.mess && this.append("div").html(opts.mess).classed("loader", true)
    const offscreen = canvas.transferControlToOffscreen();
    const src = "onmessage = "+drawloader.toString(), type = 'text/javascript';
    const url = URL.createObjectURL(new Blob([src],{type}));
    const worker = new Worker(url);
    worker.postMessage({canvas: offscreen, size}, [offscreen]);
    this.removeLoader = () => { worker.terminate(); URL.revokeObjectURL(url)
        this.select("canvas.loader").remove(); 
        this.remove();
    };
    return this;
////-----------------------------------------------------------------------	
    function drawloader(e) {
        const canvas = e.data.canvas;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const size = e.data.size;
        const radius = size / 2;
        const tau = 2 * Math.PI;
        function drawBackground() {
            ctx.beginPath();
            ctx.arc(radius, radius, radius, 0, tau);
            ctx.arc(radius, radius, radius * 0.9, 0, tau, true);
            ctx.fillStyle = '#444';
            ctx.fill();
        }
        function drawArc(angle) {
            ctx.beginPath();
            ctx.arc(radius, radius, radius, -tau / 8 + angle, tau / 8 + angle);
            ctx.arc(radius, radius, radius * 0.9, tau / 8 + angle, -tau / 8 + angle, true);
            ctx.fillStyle = '#fff';
            ctx.fill();
        }
        let startTime;
        function spin(timestamp) {
            if (!startTime) startTime = timestamp;
            const elapsed = timestamp - startTime;
            const rotation = (elapsed / 1500) * tau; // 1500msで1回転
            ctx.clearRect(0, 0, size, size);
            drawBackground();
            ctx.save();
            ctx.translate(radius, radius);
            ctx.rotate(rotation);
            ctx.translate(-radius, -radius);
            drawArc(0);
            ctx.restore();
            requestAnimationFrame(spin);
        }
        requestAnimationFrame(spin);
    };
};