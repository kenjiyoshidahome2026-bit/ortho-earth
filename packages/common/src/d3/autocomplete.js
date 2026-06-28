import * as d3 from 'd3';
import './autocomplete.scss';

export const createAutocomplete = (container, options = {}) => {
    const {
        items = [],
        onSelect = null,
        placeholder = "Search...",
        maxResults = 10
    } = options;

    let currentIndex = -1;
    let filteredData = [];

    const wrapper = d3.select(container).append("div").classed("autocomplete-wrapper", true);
    const input = wrapper.append("input")
        .attr("type", "text")
        .attr("placeholder", placeholder)
        .attr("autocomplete", "off");

    const listContainer = wrapper.append("div").classed("autocomplete-list hidden", true);

    const renderList = (val) => {
        if (!val) {
            listContainer.classed("hidden", true).empty();
            return;
        }

        const regex = new RegExp(`(${val})`, "gi");
        filteredData = items
            .filter(d => d.toLowerCase().includes(val.toLowerCase()))
            .slice(0, maxResults);

        if (filteredData.length === 0) {
            listContainer.classed("hidden", true).empty();
            return;
        }

        currentIndex = -1;
        listContainer.classed("hidden", false).empty();

        const itemDivs = listContainer.selectAll(".autocomplete-item")
            .data(filteredData)
            .enter()
            .append("div")
            .classed("autocomplete-item", true)
            .html(d => d.replace(regex, "<mark>$1</mark>"))
            .on("click", (e, d) => selectItem(d));
    };

    const selectItem = (val) => {
        input.property("value", val);
        listContainer.classed("hidden", true).empty();
        if (onSelect) onSelect(val);
    };

    input.on("input", function() {
        renderList(this.value);
    });

    input.on("keydown", function(e) {
        const items = listContainer.selectAll(".autocomplete-item");

        if (e.key === "ArrowDown") {
            currentIndex = Math.min(currentIndex + 1, filteredData.length - 1);
            updateActive();
            e.preventDefault();
        } else if (e.key === "ArrowUp") {
            currentIndex = Math.max(currentIndex - 1, 0);
            updateActive();
            e.preventDefault();
        } else if (e.key === "Enter") {
            if (currentIndex > -1) {
                selectItem(filteredData[currentIndex]);
            }
            e.preventDefault();
        } else if (e.key === "Escape") {
            listContainer.classed("hidden", true);
        }
    });

    const updateActive = () => {
        listContainer.selectAll(".autocomplete-item")
            .classed("active", (d, i) => i === currentIndex);

        const activeNode = listContainer.select(".active").node();
        if (activeNode) activeNode.scrollIntoView({ block: "nearest" });
    };

    d3.select(window).on("click.autocomplete", (e) => {
        if (!wrapper.node().contains(e.target)) {
            listContainer.classed("hidden", true);
        }
    });

    return { input, wrapper };
};
