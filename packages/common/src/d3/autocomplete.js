import * as d3 from 'd3';

export const createAutocomplete = (container, options = {}) => {
    const {
        items = [],        // 候補リスト
        onSelect = null,   // 決定時のコールバック
        placeholder = "Search...",
        maxResults = 10
    } = options;

    let currentIndex = -1;
    let filteredData = [];

    // 1. UIの構築
    const wrapper = d3.select(container).append("div").classed("autocomplete-wrapper", true);
    const input = wrapper.append("input")
        .attr("type", "text")
        .attr("placeholder", placeholder)
        .attr("autocomplete", "off");

    const listContainer = wrapper.append("div").classed("autocomplete-list hidden", true);

    // 2. フィルタリングと描画
    const renderList = (val) => {
        if (!val) {
            listContainer.classed("hidden", true).empty();
            return;
        }

        // 大文字小文字を区別せずにフィルタリング
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
            .html(d => d.replace(regex, "<mark>$1</mark>")) // ハイライト処理
            .on("click", (e, d) => selectItem(d));
    };

    // 3. 選択処理
    const selectItem = (val) => {
        input.property("value", val);
        listContainer.classed("hidden", true).empty();
        if (onSelect) onSelect(val);
    };

    // 4. キーボードナビゲーション
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
        
        // 必要に応じてスクロール位置を調整
        const activeNode = listContainer.select(".active").node();
        if (activeNode) activeNode.scrollIntoView({ block: "nearest" });
    };

    // 外側をクリックしたら閉じる
    d3.select(window).on("click.autocomplete", (e) => {
        if (!wrapper.node().contains(e.target)) {
            listContainer.classed("hidden", true);
        }
    });

    return { input, wrapper };
};