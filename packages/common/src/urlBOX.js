async function urlBOX(url) {
    const canEmbed = await checkEmbeddable(url);
    if (!canEmbed) {
        return window.open(url, "_blank", "noopener,noreferrer");
    }

    const plane = d3.select("body").append("div").classed("overlay-urlbox", true);
    const div = plane.append("div").classed("body", true);

    plane.append("div").classed("head", true).html(`閉じる [ <i>${url}</i> ]`)
        .on("click", e => {
            e.stopPropagation();
            div.html("")
                .transition().ease(d3.easeCubic).duration(800)
                .style("transform", "translate(0, 100%)") // transform animates more smoothly than top
                .on("end", () => plane.remove());
        });

    const iframe = div.append("iframe")
        .attr("scrolling", "auto")
        .attr("sandbox", "allow-same-origin allow-forms allow-scripts")
        .style("display", "none");

    iframe.attr("src", url);

    div.transition().ease(d3.easeCubic).duration(800)
        .style("transform", "translate(0,0)")
        .on("end", () => iframe.style("display", "block"));

    async function checkEmbeddable(targetUrl) {
        try {
            // HEAD request to get headers without downloading the body.
            const response = await fetch(targetUrl, { method: 'HEAD', mode: 'cors' });

            // X-Frame-Options DENY or SAMEORIGIN blocks iframe embedding.
            const xFrame = response.headers.get('X-Frame-Options');
            if (xFrame && (xFrame.toUpperCase() === 'DENY' || xFrame.toUpperCase() === 'SAMEORIGIN')) {
                return false;
            }

            // CSP frame-ancestors directive also blocks embedding.
            const csp = response.headers.get('Content-Security-Policy');
            if (csp && csp.toLowerCase().includes('frame-ancestors')) {
                return false;
            }

            return response.ok;
        } catch (error) {
            // CORS rejection likely means the target also blocks iframe embedding.
            return false;
        }
    }
}
