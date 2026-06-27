const domain = "https://www.e-stat.go.jp/";
const DATA_URL = (id) => domain+"stat-search/file-download?statInfId="+(id)+"&fileKind=0";
const GIS_URL = (pref, id)=> domain+"gis/statmap-search/data?statsId="+(id)+"&downloadType=2&code="+(pref);
const MAP_URL = (pref) => domain+"gis/statmap-search/data?dlserveyId=A002005212015&coordSys=1&format=shape&downloadType=5&code="+(pref);
// 最新: https://www.e-stat.go.jp/gis/statmap-search/data?dlserveyId=A002005212020&code=01&coordSys=1&format=shape&downloadType=5&datum=2000
////=====================================================================================
const comma = ECDB.Comma;
const pct = n => (n*100).toFixed(1)+"%"
const svgHead = $.SVG_HEAD;
const svgElem = $.SVG_ELEM;
JADR.GEO = $.extend(JADR.GEO||{}, {
	国勢調査,
	国勢調査比較,
	人口推移,
	世帯収入,
	民賃情報,
////------------------------------
	町丁目,
	行政境界TIP,
	地域名MAP,
	地域名11桁,
	市区町村履歴,
	役所住所
});

// (2023.02.05 sakamoto) 出力時、印刷時に JADR.EXT を利用する。
JADR.EXT = $.extend(JADR.EXT||{}, { 国勢調査: {
	// (2023.02.05 sakamoto) データ更新および出力反映、デバッグコンソール確認に利用する領域
	version: "230101-0000",
	dataUploaded: "2023/01/01 00:00", funcUpdated: null, reportUpdated: null,
	settings: {
      sources: {
		'国勢調査': { statsId: '00200521', statsYear: 2020, statsGengo: '令和2' },
		'住宅・土地統計調査': { statsId: '00200522', statsYear: 2018, statsGengo: '平成29' },
	  },
	  funcs: {
	    geoFunc: '国勢調査R2',
	    printFunc: '国勢調査情報R2'
	  },
	  saveData: {
		lastUploaded: new Date("2022-06-24T08:05:41.000Z")
	  },
	  reportPrint: {
		loadObjectBases: { 
		  国勢調査: "国勢調査R2",
		  合併: "市区町村履歴", // 常に最新
          人口推移: "人口推移R200",
          世帯収入: "世帯収入R200",
          民賃情報: "民賃情報R200"
		},
	  }
	},
	history: [ ]
} });
JADR.getExt = (t, k)=>{
  let v = JADR.EXT[t]; k = k.split(".");
  while(k.length) if(v != null) v = v[k.shift()]; else break;
  return v;
};
const getFunc = (ns, ty, sub, fallback)=>{
  const setting = (JADR.EXT["国勢調査"]||{}).settings || {func:{}};
  const funcs = ns[setting.funcs[ty]]||{};
  return (sub ? funcs[sub]: funcs)||fallback;
};
$.extend(JADR.GEO.国勢調査, {
	人口:(d)=>getFunc(JADR.GEO, 'geoFunc', '人口', 表示)(d,人口),
	世帯:(d)=>getFunc(JADR.GEO, 'geoFunc', '世帯', 表示)(d,世帯),
	住居:(d)=>getFunc(JADR.GEO, 'geoFunc', '住居', 表示)(d,住居),
	産業:(d)=>getFunc(JADR.GEO, 'geoFunc', '産業', 表示)(d,産業),
	職業:(d)=>getFunc(JADR.GEO, 'geoFunc', '職業', 表示)(d,職業),
	表示なし:(d)=>表示(d),
	$panel: null, // 国勢調査比較で利用する領域
	code: { },
	data: { } // 国勢調査比較で利用する領域
});
JADR.国勢調査情報 = {
	人口:code=>getFunc(JADR, 'printFunc', '人口', 印刷)(code,人口),
	世帯:code=>getFunc(JADR, 'printFunc', '世帯', 印刷)(code,世帯),
	住居:code=>getFunc(JADR, 'printFunc', '住居', 印刷)(code,住居),
	産業:code=>getFunc(JADR, 'printFunc', '産業', 印刷)(code,産業),
	職業:code=>getFunc(JADR, 'printFunc', '職業', 印刷)(code,職業)
};
JADR.国勢調査関数 = {
  町丁目名変換,
  町丁目名最適
};
JADR.国勢調査表示H27 = {
  人口, 世帯, 住居, 産業, 職業
};

// JADRTOPでもREPLACEしている、町丁目shapeファイルから取得できるコードと、国勢調査（最新コード）との差異
const 町丁目データ = ['町丁目', '地域名11桁', '地域名MAP'];
const REPLACE = code => (code||'').replace(/^04423/,"04216").replace(/^40305/,"40231");//宮城県富谷市/福岡県那珂川市
////==============================領域=======================================================
function 表示(d, func) { var code = REPLACE(d.properties.id), name = d.properties.name||"", area = d.properties.area||JADR.geometryArea(d.geometry);
  var div = $(ECDB.HTML("#base"));
  return JADR.GEO.国勢調査("00").then(t=>JADR.GEO.国勢調査(code).then(val=>{ if (!val) return div[0];
    var areaName = code.length ==2? JADR.地域名称(code): code.length == 5? JADR.地域名称(code.substring(0,2))+JADR.地域名称(code): JADR.地域名称(code.substring(0,5))+name;
     if (!func) div.html(areaName);
     else {
      $("[name=地区名]",div).text(areaName).css({fontSize:areaName.length > 12?"100%":"125%"});
      $("[name=総人口]",div).text(comma(val[1][0]));
      $("[name=世帯数]",div).text(comma(val[1][3]));
      $("[name=総面積]",div).html(comma((area*1e-6).toFixed(2)));
      $("[name=人口密度]",div).html(comma((val[1][0]/area*1e6).toFixed(1)));
      !val[1][0]?$("[name=コメント]",div).html("この区域には、世帯がありません"):
      !val[5][0]?$("[name=コメント]",div).html("この区域は、秘匿措置の対象区域です"):
      func(div, val, t, code);
      $("[name=領域]", div).text(areaName);
      $("[name=市区町村]", div).text(JADR.地域名称(code.substring(0,5)));
    };
    return div[0];
  }));
}
function 印刷(code, func) {
	var div = $("<div/>").css({width:"100%", fontSize:13, color:"#000"});
	return JADR.GEO.国勢調査("00").then(t=>JADR.GEO.国勢調査(REPLACE(code))
	.then(val=>val? func(div, val, t, code, true).then(()=>$(".header", div).remove()).then(()=>div[0]):div[0]));
}////=====================================================================================
function 国勢調査比較(flag,opts) {
  debugger;
}
function 国勢調査(flag) { var name = "国勢調査", PREFS = {}, hash = window._国勢調査_ = window._国勢調査_||{};
	return  flag === true?thenEachPref(load).then(sum):get(flag);
	function get(code) {
		var target = code.length > 5? code.substring(0,2): "00";
		code = +code;
		return hash[code]? Promise.resolve(hash[code]):
		JADR.loadTSV(name+"/"+target).then(putHash).then(()=>hash[code]);
		function putHash(v) { v.forEach(t=>hash[t[0]]=t); 
		//	console.log(flag, v)
		}
	}
	function load(pref) { var a = [], b = [], c = [];
		const ID = id => REPLACE((pref >9?"":"0")+id);
		const clean = a => a.map(t=>isNaN(t)?0:t);
		const convert = {
		"T000848":t=>[ID(t[0]),clean(t.slice(7))],
		"T000849":t=>[ID(t[0]),clean(t.slice(28,43).concat([t[46]])), clean(t.slice(48,63).concat([t[66]]))],
		"T000850":t=>[ID(t[0]),clean(t.slice(7))],
		"T000851":t=>[ID(t[0]),clean(t.slice(7))],
		"T000852":t=>[ID(t[0]),clean(t.slice(7))],
		"T000853":t=>[ID(t[0]),clean(t.slice(7))],
		"T000865":t=>[ID(t[0]),clean(t.slice(7))],
		"T000866":t=>[ID(t[0]),clean(t.slice(7))],
		"T000875":t=>[ID(t[0]),clean(t.slice(7))],
		};
		return thenEach(Object.keys(convert), t => read(pref, t)
		.then(v=>{a = a.concat([v[0]]), b = b.concat([v[1]]), c = c.concat([v[2]])}))
		.then(()=>{ a = merge(a), b = merge(b), c = merge(c);
			PREFS[pref] = a; 
			var p = {}; c.forEach(t=>p[t[0].slice(0,9)] = true);
			var q = c.concat(b.filter(t=>!p[t[0]])).sort((p,q)=>p[0]>q[0]?1:-1);		
			return JADR.saveTSV(name+"/"+pref, q);
		});
		function merge(a) { var q = {};
			a[0].forEach(t=>q[t[0]] = t.slice(1));
			a.slice(1).forEach(t=>t.forEach(t=>q[t[0]] = (q[t[0]]||[]).concat(t.slice(1))));
			return Object.keys(q).map(t=>[t].concat(q[t]));
		}
		function read(pref, id) {
			return bucket.getZIP(GIS_URL(pref, id)).then(v=>{ console.log(pref,id);
				var name = Object.keys(v)[0], blob = new Blob([v[name]]);
				blob.name = name.replace(/.txt$/,".csv");
				return bucket.blob2csv(blob).then(v=>[1,2,3].map(n=>v.filter(t=>t[1]===n).map(convert[id])));
			});
		}
	}
	function sum() { var a = [], p = [];
		Object.keys(PREFS).forEach(pref=>{
			a = a.concat(PREFS[pref]); p.push(sumup(pref, PREFS[pref]));
		});
		a = a.concat(p); a.push(sumup("00", p));
		JADR.saveTSV(name+"/00", a.sort((p,q)=>p[0]>q[0]?1:-1))
		function sumup(key, a) { var v = [].concat(a.shift().map(t=>[].concat(t))); v[0] = key;
			a.forEach(t=>{
				for(var i = 1; i < t.length; i++) {
					$.isArray(v[i])? v[i].forEach((s,j)=> v[i][j] += t[i][j]): v[i] += t[i];
				}
			});
			return v;
		}
	}
}
////-----------------------------------------------------------------------------------------------
function 人口(div, val, japan, code, pflag) { 
	div.append(ECDB.HTML("[name=人口]"));
	const date = s => s.substring(0,4)+"-"+s.substring(4,6)+"-"+s.substring(6,8);
	$("[name=人口構成]",div).html(人口構成());
	if (pflag && code.length > 5) { return $(".code",div).remove(); }
	return Promise.all([
		人口推移(code,pflag).then(v=>$("[name=人口推移]",div).html(v)),
		市区町村履歴(code).then(v=>{
			let tbl = "<table class='history'>"+(v||[]).map(t=>"<tr><th>"+date(t[0])+"</th><td>"+t[1]+"</td></tr>").join("")+"</table>";
			v && v.length && $("[name=合併履歴]",div).html(tbl);
		})
	])
	function 人口構成() {
		var fg = pflag?"#000":"#fff";//cl
		var s0 = val[1][1], s1 = val[1][2];
		var d0=percent([].concat(val[2]).reverse(),5);
		var d1=percent([].concat(val[3]).reverse(),5);
		var t0=percent([].concat(japan[2]).reverse(),5);
		var t1=percent([].concat(japan[3]).reverse(),5);
		var svg = svgHead(-115,-5,230,190);
		svgElem("rect",{x:-110,y:0,width:220,height:170,fill:"none",stroke:fg,"stroke-width":2}).appendTo(svg);
		var g = svgElem("g",{"text-anchor":"middle", "dominant-baseline":"middle", "font-size":8,"font-family":"Verdana"}).appendTo(svg);
		var gb = svgElem("g",{"font-size":10, "font-weight":700}).appendTo(g);
		svgElem("path",{d:"M-60,0v170M-10,0v170M10,0v170M60,0v170",fill:"none",stroke:fg,"stroke-width":1}).appendTo(svg);
		svgElem("path",{d:"M-85,0v170M-35,0v170M35,0v170M85,0v170",fill:"none",stroke:fg,"stroke-width":1, "stroke-dasharray":"5 1"}).appendTo(svg);
		for (var i = 0; i < 4; i++) { var x = 10+(i*25)
			svgElem("text",{x:-x,y:178,fill:fg},i*5+"%").appendTo(g);
			svgElem("text",{x: x,y:178,fill:fg},i*5+"%").appendTo(g);
		}
		var CL=["#80f","#804","#88f","#fcc","#8f0","#f80"];
		var D0 = [], D1 = [], T0 = [], T1 = [];
		svgElem("text",{x:-100,y:145,fill:CL[pflag?0:2],"text-anchor":"start"},"男性").appendTo(gb);
		svgElem("text",{x:-100,y:160,fill:fg,"text-anchor":"start"},comma(s0)).appendTo(gb);
		svgElem("text",{x: 100,y:145,fill:CL[pflag?1:3],"text-anchor":"end"},"女性").appendTo(gb);
		svgElem("text",{x: 100,y:160,fill:fg,"text-anchor":"end"},comma(s1)).appendTo(gb);
		svgElem("path", {d:"M75,110h20", stroke:pflag?"#060":"#8f0", "stroke-width":"1", fill:"none"}).appendTo(svg);
		svgElem("text", {x:85, y:120, fill:fg,"font-size":10},"全国平均").appendTo(g);
		for(var i = 0; i < 3; i++) { var n = (i+1)*10, os = 10;
			D0.push("M-"+os+","+n+"h-"+d0[i]);
			D1.push("M"+os+","+n+"h"+d1[i]);
		}
		svgElem("path", {d:D0.join(""), stroke:CL[0], "stroke-width":"8"}).appendTo(svg);
		svgElem("path", {d:D1.join(""), stroke:CL[1], "stroke-width":"8"}).appendTo(svg);
		D0 = [], D1 = [];
		for(var i = 3; i < 13; i++) { var n = (i+1)*10, os = 10;
			D0.push("M-"+os+","+n+"h-"+d0[i]);
			D1.push("M"+os+","+n+"h"+d1[i]);
		}
		svgElem("path", {d:D0.join(""), stroke:CL[2], "stroke-width":"8"}).appendTo(svg);
		svgElem("path", {d:D1.join(""), stroke:CL[3], "stroke-width":"8"}).appendTo(svg);
		D0 = [], D1 = [];
		for(var i = 13; i < 16; i++) { var n = (i+1)*10, os = 10;
			D0.push("M-"+os+","+n+"h-"+d0[i]);
			D1.push("M"+os+","+n+"h"+d1[i]);
		}
		svgElem("path", {d:D0.join(""), stroke:CL[4], "stroke-width":"8"}).appendTo(svg);
		svgElem("path", {d:D1.join(""), stroke:CL[5], "stroke-width":"8"}).appendTo(svg);
		for(var i = 0; i < 16; i++) { var n = (i+1)*10, os = 10;
			svgElem("text",{x:0,y:n,fill:fg}, ((15-i)*5)+"~").appendTo(g);
			T0.push((i?"L":"M")+"-"+(t0[i]+os)+","+n);
			T1.push((i?"L":"M")+(t1[i]+os)+","+n);
		}
		svgElem("path", {d:T0.join("")+T1.join(""), stroke:pflag?"#060":"#8f0", "stroke-width":"1", fill:"none"}).appendTo(svg);
		return svg;
		function percent(a, n) { var sum = Math.SUM(a); a = a.map(t=>t/sum*100*(n||1)); return a; }
	}
}
////-----------------------------------------------------------------------------------------------
function 人口推移(flag, pflag) { var name = "人口推移00"; var Q ={};
	const num = s => +((""+s).replace(/,/g,""));
	var years = ["平成27年","平成22年","平成17年","平成12年","平成7年","平成2年","昭和60年","昭和60年"];
	var urls = [
		1085975, 1085976, 1085977, 1085978, 1085979,
		1085980, 1085981, 1085982, 1085983, 1085984,
		1085985, 1085986, 1085987, 1085988, 1085989,
		1085990, 1085991, 1085992, 1085993, 1085994,
		1085995, 1085996, 1085997, 1085998, 1085999,
		1086000, 1086001, 1086002, 1086003, 1086004,
		1086005, 1086006, 1086007, 1086008, 1086009,
		1086010, 1086011, 1086012, 1086013, 1086014,
		1086015, 1086016, 1086017, 1086018, 1086019,
		1086020, 1086021].map(t=>"00000"+t).map(t=>DATA_URL(t));
	return flag === true? thenEachPref(pref=>bucket.getXLS(urls[(+pref)-1]).then(v=>{
	//	console.log(pref, v);
		years.forEach((year,i)=>{
			v[year].filter(t=>(""+t[0]).match(/^\d+$/)).map(t=>{
				var code = REPLACE((t[0]<9999?"0":"")+t[0]);
				Q[code] = Q[code]||[];
				Q[code][i] = [num(t[7]),num(t[8]),num(t[9]),num(t[11]),num(t[12]),num(t[13])];
			});
		});
	})).then(()=>{
		Q = Object.keys(Q).map(t=>[t].concat(years.map((y,i)=>Q[t][i]=Q[t][i]||[]))).sort((p,q)=>p[0]>q[0]?1:-1);
		JADR.saveObject(name, Q);
	}):
	((code)=>{ code = code.length === 2? code +"000": code.substring(0,5);
		return JADR.loadObject(name).then(v=>SVG(v.filter(t=>t[0]==code)[0].slice(1)));
	})(flag);
	function SVG(a) { var size = a.length *10, y = size-10, fg = pflag?"#000":"#fff";
		var max = Math.max(Math.MAX(a.map(t=>t.length?t[0]+t[1]+t[2]:0)),Math.MAX(a.map(t=>t.length?t[3]+t[4]+t[5]:0)));
		var svg = svgHead(-20,-5,size+25,size+10,{ preserveAspectRatio:"none"});
		var g = svgElem("g",{"text-anchor":"middle", "dominant-baseline":"middle", "font-size":3.5,"font-family":"Verdana","fill":fg}).appendTo(svg);
		var p =[[],[],[],[],[],[]], H = y/(max*1.1), ln = Math.log10(max*1.1);
		var grid = Math.pow(10, Math.floor(ln))*((ln-Math.floor(ln))<0.5?0.5:1), grs = [];
		for (var gr = 0; gr < max*1.1; gr += grid) {
			grs.push("M0,"+(1 - gr/(max*1.1))*y+"h"+size);
			svgElem("text",{x:-2, y:(1 - gr/(max*1.1))*y,"text-anchor":"end"}, ECDB.Comma(gr)).appendTo(g);
		}
		svgElem("path",{d:grs.join(""), stroke:fg, "stroke-width":0.4}).appendTo(svg);
		[].concat(a).reverse().forEach((t,i)=>{ if (!t || !t.length) return;
			p[0].push("M"+(i*10+3)+","+y+"v-"+((t[0]+t[1]+t[2])*H));
			p[1].push("M"+(i*10+7)+","+y+"v-"+((t[3]+t[4]+t[5])*H));
			p[2].push("M"+(i*10+3)+","+y+"v-"+((t[0]+t[1])*H));
			p[3].push("M"+(i*10+7)+","+y+"v-"+((t[3]+t[4])*H));
			p[4].push("M"+(i*10+3)+","+y+"v-"+((t[0])*H));
			p[5].push("M"+(i*10+7)+","+y+"v-"+((t[3])*H));
		});
		["#80f","#804","#88f","#fcc","#8f0","#f80"].forEach((cl,i)=>
		svgElem("path",{d:p[i].join(""), stroke:cl, "stroke-width":4}).appendTo(svg));
		["1981","1986","1991","1996","2001","2006","2011","2016"].forEach((s,i)=>
		svgElem("text",{x:i*10+5, y:size-4,transform:"rotate(-90 "+(i*10+5)+" "+(size-4)+")"},s).appendTo(g));
		svgElem("rect",{x:0,y:0,width:size,height:y,fill:"none",stroke:fg,"stroke-width":0.8}).appendTo(svg);
		return svg[0].outerHTML;
	}
}
////-----------------------------------------------------------------------------------------------
function 世帯(div, val, t, code, pflag) { let fg = pflag?"#000":"#fff";
	const diff = (a,b) => a-b>0.01?"<span style='color:#008;'>⬆︎</span>":b-a>0.01?"<span style='color:#800;'>⬇︎</span>":"";
	div.append(ECDB.HTML("[name=世帯]"))
	$("[name=世帯人数]",div).html(世帯人数(val[4]));
	$("[name=経済構成]",div).html(経済構成(val[10]));
	$("[name=平均世帯人数]",div).html((t[4][6]/t[4][0]).toFixed(2));
	$("[name=LR0]",div).html(comma(val[5][0]));
	$("[name=L1]",div).html(pct(val[5][1]/val[5][0]));
	$("[name=L2]",div).html(pct(val[5][2]/val[5][0]));
	$("[name=L3]",div).html(pct(val[5][3]/val[5][0]));
	$("[name=L4]",div).html(pct(val[5][6]/val[5][0]));
	$("[name=L5]",div).html(pct(val[5][7]/val[5][0]));
	$("[name=L6]",div).html(pct(val[5][8]/val[5][0]));
	$("[name=R1]",div).html(diff(val[5][1]/val[5][0], t[5][1]/t[5][0]));
	$("[name=R2]",div).html(diff(val[5][2]/val[5][0], t[5][2]/t[5][0]));
	$("[name=R3]",div).html(diff(val[5][3]/val[5][0], t[5][3]/t[5][0]));
	$("[name=R4]",div).html(diff(val[5][6]/val[5][0], t[5][6]/t[5][0]));
	$("[name=R5]",div).html(diff(val[5][7]/val[5][0], t[5][7]/t[5][0]));
	$("[name=R6]",div).html(diff(val[5][8]/val[5][0], t[5][8]/t[5][0]));
	if (pflag && code.length > 5) { return $(".code",div).remove(); }
	return 世帯収入(code.substring(0,5), pflag).then(v=>$("[name=世帯収入]",div).html(v)).then(()=>div[0]);
	function 世帯人数(v) {
		var a = [v[1],v[2],v[3],v[4],v[5],v[0]-(v[1]+v[2]+v[3]+v[4]+v[5])];
		var r = 30, cl = ["#800","#f40","#880","#080","#008","#808"];
		const accumulate = (a) => { var n = 0; return a.map((t) => { n += (t == null)? 0: t; return n; }) };
		var svg = svgHead(-50,-45,100,90);
		var g = svgElem("g",{"text-anchor":"middle", "dominant-baseline":"middle", "font-size":7,"font-family":"Verdana",fill:"#fff"});
		var total = Math.SUM(a); a = a.map(t=>t/total);
		var sum = accumulate(a), len = r*2*Math.PI;
		a.forEach((t, n)=>{ arc(sum[n]-t, t, cl[n]);
			var rr = (0.5 - (sum[n] - t/2))*Math.PI*2;
			svgElem("text", {x:r*Math.sin(rr),y:r*Math.cos(rr)},(n+1)+(n==5?"+":"人")).appendTo(g);
		});
		g.appendTo(svg)
		svgElem("text", {x:0,y:-5,fill:fg,"font-size":"8", "font-weight":700},(v[6]/v[0]).toFixed(2)).appendTo(g);
		svgElem("text", {x:0,y:5,fill:fg},"[人/世帯]").appendTo(g);
		function arc(start, v, cl) {
			svgElem("circle",{cx:0, cy:0, r:r, fill:"none", stroke:cl,"stroke-width":25,
			"stroke-dashoffset":(0.25 - start)*len, "stroke-dasharray":[v*len,(1-v)*len].join(",")}).appendTo(svg)
		}
		return svg
	}
	function 経済構成(v) {
		var svg = svgHead(-5,-5,110,40);
		svgElem("rect",{x:0,y:0,width:100,height:15,fill:"#888"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:(v[1]+v[2]+v[3]+v[4])*100/v[0],height:15,fill:"#808"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:(v[1]+v[2]+v[3])*100/v[0],height:15,fill:"#008"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:(v[1]+v[2])*100/v[0],height:15,fill:"#080"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:(v[1])*100/v[0],height:15,fill:"#800"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:100,height:15,fill:"none",stroke:fg, "stroke-width":1}).appendTo(svg);
		var g = svgElem("g",{"text-anchor":"middle", "dominant-baseline":"middle", "font-size":4,"font-family":"Verdana","fill":fg}).appendTo(svg);
		svgElem("path", {d:"M0,15v15M25,20v10M50,20v10M75,20v10M100,20v10", stroke:fg, "stroke-width":0.5}).appendTo(svg);
		svgElem("path", {d:"M25,20L"+(v[1])*100/v[0]+",15", stroke:fg, "stroke-width":0.5}).appendTo(svg);
		svgElem("path", {d:"M50,20L"+(v[1]+v[2])*100/v[0]+",15", stroke:fg, "stroke-width":0.5}).appendTo(svg);
		svgElem("path", {d:"M75,20L"+(v[1]+v[2]+v[3])*100/v[0]+",15", stroke:fg, "stroke-width":0.5}).appendTo(svg);
		svgElem("path", {d:"M100,20L"+(v[1]+v[2]+v[3]+v[4])*100/v[0]+",15", stroke:fg, "stroke-width":0.5}).appendTo(svg);
		svgElem("text",{x:12.5,y:23},"農林漁").appendTo(g);
		svgElem("text",{x:37.5,y:23},"混合").appendTo(g);
		svgElem("text",{x:62.5,y:23},"非農林漁").appendTo(g);
		svgElem("text",{x:87.5,y:23},"非就業").appendTo(g);
		svgElem("text",{x:12.5,y:28},pct(v[1]/v[0])).appendTo(g);
		svgElem("text",{x:37.5,y:28},pct(v[2]/v[0])).appendTo(g);
		svgElem("text",{x:62.5,y:28},pct(v[3]/v[0])).appendTo(g);
		svgElem("text",{x:87.5,y:28},pct(v[4]/v[0])).appendTo(g);
		return svg;
	}
}
////-----------------------------------------------------------------------------------------------
function 世帯収入(flag, pflag) { var name = "世帯収入00", q = {}, fg = pflag?"#000":"#fff";
	const num = s => { s = (""+s).replace(/,/g,""); return isNaN(s)?0:+s;};
	const toCode = n => { n = Math.floor(n/100); return (n < 9999? "0":"")+n };
	var urls = [
		28111597, 27334521, 27244013, 27244125, 27334803,
		27245823, 27244237, 27868043, 27335676, 27868160,
		28111709, 28112018, 28112135, 28112667, 27868266,
		27246095, 27246380, 27240951, 27246650, 27868352,
		27868463, 27868584, 28113181, 27868778, 27338693,
		27868896, 28113308, 28113413, 27338963, 27246942,
		27247218, 27241052, 27869226, 27869336, 27339235,
		27241169, 27247490, 27339737, 27247764, 28113756,
		27248039, 27339993, 27340485, 27340757, 27248314,
		27869443, 27341015].map(t=>"0000"+t).map(t=>DATA_URL(t));
	return flag === true? thenEachPref(pref=> bucket.getXLS(urls[(+pref)-1]).then(v=>{
		v = v.B089.filter(t=>t && toCode(t[1]).substring(0,2)===pref)
		.map(t=>[REPLACE(toCode(t[1])),t[5]-1].concat(t.slice(10,19).map(num)));
		v.forEach(t=>{ q[t[0]]=q[t[0]]||[]; q[t[0]][t[1]] = t.slice(2); });
	})).then(()=>{
		q = Object.keys(q).map(t=>[t, xy2yx(q[t])]);
		return JADR.saveObject(name, q);
	}):
	((code)=>{ code = code.length === 2? code: code.substring(0,5);
		return JADR.loadObject(name).then(v=>{
			v = v.filter(t=>t[0]==+code)[0];
			return v? SVG(v[1]):"<div>町村人口が15,000人以下のため<br/>統計がありません</div>";
		});
	})(flag);
	function SVG(a) { var x = 90, y = 8*6;
		var total = a[0][0], r = a[0].slice(1,10).map(t=>t*160/total);
		var svg = svgHead(-10,-5,x+15,y+20,{ preserveAspectRatio:"none"});
		var grs = [];
		for (var gr = 1; gr < 6; gr++) grs.push("M0,"+gr*8+"h"+x);
		svgElem("path",{d:grs.join(""), stroke:fg, "stroke-width":0.5}).appendTo(svg);
		var r1 = r.map((t,i)=>"M"+(i*10+6)+","+y+"v-"+(t+1));
		var r2 = r.map((t,i)=>"M"+(i*10+5)+","+y+"v-"+t);
		svgElem("path",{d:r1.join(""), stroke:"#006", "stroke-width":8}).appendTo(svg);
		svgElem("path",{d:r2.join(""), stroke:"#88f", "stroke-width":8}).appendTo(svg);
		r1 = a[2].slice(1,10).map(t=>t*160/a[2][0]).map((t,i)=>(i?"L":"M")+(i*10+5)+","+(y-t));
		r2 = a[3].slice(1,10).map(t=>t*160/a[3][0]).map((t,i)=>(i?"L":"M")+(i*10+5)+","+(y-t));
		svgElem("path",{d:r1.join(""), stroke:"#0a0",fill:"none", "stroke-width":2}).appendTo(svg);
		svgElem("path",{d:r2.join(""), stroke:"#f80",fill:"none", "stroke-width":2}).appendTo(svg);
		svgElem("rect",{x:0,y:0,width:x,height:y,fill:"none",stroke:fg,"stroke-width":1}).appendTo(svg);
		var g = svgElem("g",{"text-anchor":"middle", "dominant-baseline":"middle", "font-size":4,"font-family":"Verdana","fill":fg}).appendTo(svg);
		[100,200,300,400,500,700,1000,1500].map(t=>t+"万").forEach((s,i)=>
		svgElem("text",{x:(i+1)*10, y:y+8,transform:"rotate(-90 "+((i+1)*10)+" "+(y+8)+")"},s).appendTo(g));
		for (var gr = 0; gr < 6; gr++) svgElem("text",{x:-1, y:y-gr*8, "text-anchor":"end"},gr*5+"%").appendTo(g);
		var gg = svgElem("g",{"font-size":5}).appendTo(g);
		svgElem("text",{x:20, y:4},"対象世帯数").appendTo(gg);
		svgElem("text",{x:20, y:12,fill:pflag?"#008":"#cff"},comma(total)).appendTo(gg);
		svgElem("text",{x:70, y:4, fill:"#0a0"},"持家世帯").appendTo(gg);
		svgElem("text",{x:70, y:12,fill:"#f80"},"借家世帯").appendTo(gg);
		return svg[0].outerHTML;
	}
}////-----------------------------------------------------------------------------------------------
function 住居(div, val, t, code, pflag) { let fg = pflag?"#000":"#fff";
	div.append(ECDB.HTML("[name=住居]"));
	$("[name=対象世帯数]",div).html(comma(val[6][0]));
	$("[name=住宅区分]",div).html(住宅区分(val[6]));
	$("[name=住宅建築]",div).html(住宅建築(val[7]));
	if (pflag && code.length > 5) { return $(".code",div).remove(); }
	return 民賃情報(code.substring(0,5),pflag).then(v=>$("[name=民賃情報]",div).html(v)).then(()=>div[0]);
	function 住宅区分(v) {
		var svg = svgHead(-5,-5,110,40);
		svgElem("rect",{x:0,y:0,width:100,height:15,fill:"#888"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:(v[1]+v[2])*100/v[0],height:15,fill:"#f80"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:(v[1])*100/v[0],height:15,fill:"#0a0"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:100,height:15,fill:"none",stroke:fg, "stroke-width":1}).appendTo(svg);
		var g = svgElem("g",{"text-anchor":"middle", "dominant-baseline":"middle", "font-size":4,"font-family":"Verdana","fill":fg}).appendTo(svg);
		svgElem("path", {d:"M0,15v15M100,15v15M30,20v10M70,20v10", stroke:fg, "stroke-width":0.5}).appendTo(svg);
		svgElem("path", {d:"M30,20L"+(v[1])*100/v[0]+",15", stroke:fg, "stroke-width":0.5}).appendTo(svg);
		svgElem("path", {d:"M70,20L"+(v[1]+v[2])*100/v[0]+",15", stroke:fg, "stroke-width":0.5}).appendTo(svg);
		svgElem("text",{x:15,y:23},"持ち家").appendTo(g);
		svgElem("text",{x:50,y:23},"民営借家").appendTo(g);
		svgElem("text",{x:85,y:23},"その他").appendTo(g);
		svgElem("text",{x:15,y:28},pct(v[1]/v[0])).appendTo(g);
		svgElem("text",{x:50,y:28},pct(v[2]/v[0])).appendTo(g);
		svgElem("text",{x:85,y:28},pct((v[0]-v[1]-v[2])/v[0])).appendTo(g);
		return svg;
	}
	function 住宅建築(v) {
		var svg = svgHead(-5,-5,110,40);
		svgElem("rect",{x:0,y:0,width:100,height:15,fill:"#888"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:(v[1]+v[2]+v[4]+v[5]+v[6]+v[7])*100/v[0],height:15,fill:"#808"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:(v[1]+v[2]+v[4]+v[5]+v[6])*100/v[0],height:15,fill:"#c00"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:(v[1]+v[2]+v[4]+v[5])*100/v[0],height:15,fill:"#f40"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:(v[1]+v[2]+v[4])*100/v[0],height:15,fill:"#f80"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:(v[1]+v[2])*100/v[0],height:15,fill:"#0c0"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:(v[1])*100/v[0],height:15,fill:"#080"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:100,height:15,fill:"none",stroke:fg, "stroke-width":1}).appendTo(svg);
		var g = svgElem("g",{"text-anchor":"middle", "dominant-baseline":"middle", "font-size":4,"font-family":"Verdana","fill":fg}).appendTo(svg);
		svgElem("path", {d:"M0,15v15M100,15v15M30,20v10M50,20v10", stroke:fg, "stroke-width":0.5}).appendTo(svg);
		svgElem("path", {d:"M30,20L"+(v[1])*100/v[0]+",15", stroke:fg, "stroke-width":0.5}).appendTo(svg);
		svgElem("path", {d:"M50,20L"+(v[1]+v[2])*100/v[0]+",15", stroke:fg, "stroke-width":0.5}).appendTo(svg);
		svgElem("text",{x:15,y:23},"戸建").appendTo(g);
		svgElem("text",{x:40,y:23},"長屋").appendTo(g);
		svgElem("text",{x:58,y:23},"共同").appendTo(g);
		var gg = svgElem("g",{"font-family":"Arial Narrow"}).appendTo(g);
		svgElem("text",{x:68,y:23, fill:"#f80"},"1-2").appendTo(gg);
		svgElem("text",{x:77,y:23, fill:"#f40"},"3-5").appendTo(gg);
		svgElem("text",{x:86,y:23, fill:"#c00"},"6-10").appendTo(gg);
		svgElem("text",{x:95,y:23, fill:"#808"},"11-").appendTo(gg);
		svgElem("text",{x:15,y:28},pct(v[1]/v[0])).appendTo(g);
		svgElem("text",{x:40,y:28},pct(v[2]/v[0])).appendTo(g);
		svgElem("text",{x:75,y:28},pct((v[4]+v[5]+v[6]+v[7])/v[0])).appendTo(g);
		return svg;
	}
}
////-----------------------------------------------------------------------------------------------
function 民賃情報(flag, pflag) { var name = "民賃情報00",  q = {}, fg = pflag?"#000":"#fff";
	const num = s => { s = (""+s).replace(/,/g,""); return isNaN(s)?0:+s;};
	const toCode = n => { n = Math.floor(n/100); return (n < 9999? "0":"")+n };
	var urls = [
		28111639, 27334563, 27244055, 27244167, 27334845,
		27245865, 27244279, 27868085, 27335718, 27868202,
		28111751, 28112060, 28112177, 28112709, 27868298,/*新潟のみGAPが異なる(32):>15000の町村がないため*/
		27246137, 27246422, 27240993, 27246692, 27868394,
		27868505, 27868626, 28113223, 27868820, 27338735,
		27868938, 28113350, 28113455, 27339005, 27246984,
		27247260, 27241094, 27869268, 27869378, 27339277,
		27241211, 27247532, 27339779, 27247806, 28113798,
		27248081, 27340035, 27340527, 27340799, 27248356,
		27869485, 27341057].map(t=>"0000"+t).map(t=>DATA_URL(t));
	return flag === true? thenEachPref(pref=> bucket.getXLS(urls[(+pref)-1]).then(v=>{
	//	console.log(pref, v);
		v = v.B195.filter(t=>t && toCode(t[1]).substring(0,2)==pref)
		.map(t=>[REPLACE(toCode(t[1])),t[5]-1].concat(t.slice(10,24).map(num)));
		v.forEach(t=>{ q[t[0]]=q[t[0]]||[]; q[t[0]][t[1]] = t.slice(2); });
	})).then(()=>{
		q = Object.keys(q).map(t=>[t, q[t]]);
		return JADR.saveObject(name, q);
	}):
	((code)=>{ code = code.length === 2? code: code.substring(0,5);
		return JADR.loadObject(name).then(v=>{
			v = v.filter(t=>t[0]==code)[0];
			return v? SVG(v[1]):"<div>町村人口が15,000人以下のため<br/>統計がありません</div>";
		});
	})(flag);
	function SVG(a) { var y0 = 120, x = 90, y = y0*0.4; 
		var total = a[0][0], avr = a[0][13], r = a[0].slice(2,11).map(t=>t*y0/total);
		var svg = svgHead(-10,-5,x+15,y+20,{ preserveAspectRatio:"none"});
		var grs = [];
		for (var gr = 1; gr < 8; gr++) grs.push("M0,"+gr*6+"h"+x);
		svgElem("path",{d:grs.join(""), stroke:fg, "stroke-width":0.5}).appendTo(svg);
		var r1 = r.map((t,i)=>"M"+(i*10+6)+","+y+"v-"+(t+1));
		var r2 = r.map((t,i)=>"M"+(i*10+5)+","+y+"v-"+t);
		svgElem("path",{d:r1.join(""), stroke:"#006", "stroke-width":8}).appendTo(svg);
		svgElem("path",{d:r2.join(""), stroke:"#88f", "stroke-width":8}).appendTo(svg);
		svgElem("rect",{x:0,y:0,width:x,height:y,fill:"none",stroke:fg,"stroke-width":1}).appendTo(svg);
		var g = svgElem("g",{"text-anchor":"middle", "dominant-baseline":"middle", "font-size":4,"font-family":"Verdana","fill":fg}).appendTo(svg);
		[1,2,4,6,8,10,15,20].map(t=>t+"万円").forEach((s,i)=>
		svgElem("text",{x:(i+1)*10, y:y+8,transform:"rotate(-90 "+((i+1)*10)+" "+(y+8)+")"},s).appendTo(g));
		for (var gr = 0; gr < 8; gr++) svgElem("text",{x:-1, y:y-gr*6,"text-anchor":"end"}, gr*5+"%").appendTo(g);
		var gg = svgElem("g",{"font-size":4}).appendTo(g);
		svgElem("text",{x:20, y:3},"借家世帯数").appendTo(gg);
		svgElem("text",{x:70, y:3},"平均家賃額").appendTo(gg);
		svgElem("text",{x:20, y:9,fill:pflag?"#008":"#cff"},comma(total)).appendTo(gg);
		svgElem("text",{x:70, y:9,fill:pflag?"#008":"#cff"},comma(avr)+"円").appendTo(gg);
		return svg[0].outerHTML;
	}
}
////-----------------------------------------------------------------------------------------------
function 産業(div, val, t, code, pflag) { let fg = pflag?"#000":"#fff";
	div.append(ECDB.HTML("[name=産業]"));
	const q = [
		["A","#0c0","農業","農業"],
		["a","#080","林業","林業"],
		["B","#008","漁業","漁業"],
		["C","#444","鉱業","鉱業・採石業・砂利採取業"],
		["D","#088","建設","建設業"],
		["E","#0f8","製造","製造業"],
		["F","#c00","インフラ","電気・ガス・熱供給・水道業"],
		["G","#0ff","情報通信","情報通信業"],
		["H","#880","運輸郵便","運輸業・郵便業"],
		["I","#f80","卸売小売","卸売業・小売業"],
		["J","#fc0","金融保険","金融業・保険業"],
		["K","#00c","不動産","不動産業・物品賃貸業"],
		["L","#808","研究","学術研究・専門・技術サービス業"],
		["M","#800","宿泊飲食","宿泊業・飲食サービス業"],
		["N","#8f0","生活関連","生活関連サービス業・娯楽業"],
		["O","#0f8","教育","教育・学習支援業"],
		["P","#08f","医療福祉","医療・福祉"],
		["Q","#f40","複合","複合サービス事業"],
		["R","#c08","サービス","サービス業(他に分類されないもの)"],
		["S","#f08","公務","公務(他に分類されるものを除く)"],
		["T","#888","その他","分類不能の産業"]
	];
	var a = [val[8][2],val[8][1]-val[8][2]].concat(val[8].slice(3,22))
	.map((t,i)=>[t].concat(q[i])).sort((p,q)=>p[0]>q[0]?-1:1);
//	$("[name=市区町村]",div).text(JADR.地域名称(code.substring(0,5)));
	$("[name=産業分類]",div).html(産業分類([].concat(a)));
	$("[name=産業種類]",div).html(産業種類(a));
	return Promise.resolve(div[0])
	function 産業分類(a) {
		var r = 30, v = a.map(t=>t[0]), total = Math.SUM(v);
		const accumulate = (a) => { var n = 0; return a.map((t) => { n += (t == null)? 0: t; return n; }) };
		var svg = svgHead(-50,-45,100,90);
		var g = svgElem("g",{"text-anchor":"middle", "dominant-baseline":"middle", "font-size":4,"font-family":"Verdana",fill:fg});
		v = v.map(t=>t/total);
		var sum = accumulate(v), len = r*2*Math.PI;
		a.forEach((t, n)=>{ arc(sum[n]-v[n], v[n], t[2]);
			var rr = (0.5 - (sum[n] - v[n]/2))*Math.PI*2;
			v[n]>0.03 && svgElem("text", {x:r*Math.sin(rr),y:r*Math.cos(rr),fill:"#fff"},t[1]).appendTo(g);
		});
		g.appendTo(svg);
		svgElem("text", {x:0,y:-8, "font-size":6}, "対象者").appendTo(g);
		svgElem("text", {x:0,y:0, "font-size":6,"font-weight":700}, comma(total)).appendTo(g);
		svgElem("text", {x:0,y:8, "font-size":6}, "[人]").appendTo(g);
		function arc(start, v, cl) {
			svgElem("circle",{cx:0, cy:0, r:r, fill:"none", stroke:cl,"stroke-width":25,
			"stroke-dashoffset":(0.25 - start)*len, "stroke-dasharray":[v*len,(1-v)*len].join(",")}).appendTo(svg)
		}
		return svg.css({width:"75%"})
	}
	function 産業種類(a) { var div = $("<div class='legend'/>"); var total = Math.SUM(a.map(t=>t[0]));
		a.filter(t=>t[0]).forEach((t)=>{
			$("<div><span class='mark' style='background:"+t[2]+"'>"+t[1]+"</span><span>"+t[3]+"</span><span>"+pct(t[0]/total)+"</span></div>").appendTo(div);
		});
		return div;
	}
}
////-----------------------------------------------------------------------------------------------
function 職業(div, val, t, code, pflag) { let fg = pflag?"#000":"#fff";
	div.append(ECDB.HTML("[name=職業]"));
	const q = [
		["A","#c00","管理職","管理的職業従事者"],
		["B","#f80","専門技術職","専門的・技術的職業従事者"],
		["C","#c0c","事務","事務従事者"],
		["D","#808","販売","販売従事者"],
		["E","#880","サービス","サービス職業従事者"],
		["F","#8ff","保安","保安職業従事者"],
		["G","#088","農林漁業","農林漁業従事者"],
		["H","#0ff","生産","生産工程従事者"],
		["I","#0f8","輸送","輸送・機械運転従事者"],
		["J","#08f","建設","建設・採掘従事者"],
		["K","#cc0","運搬","運搬・清掃・包装等従事者"],
		["L","#888","その他","分類不能の職業"]
	];
	var a = val[9].slice(1,13)
	.map((t,i)=>[t].concat(q[i])).sort((p,q)=>p[0]>q[0]?-1:1);
	$("[name=職業分類]",div).html(職業分類([].concat(a)));
	$("[name=職業種類]",div).html(職業種類(a));
	$("[name=地位分類]",div).html(地位分類([val[8][0],val[8][23],val[8][22],val[8][24]]));
	return Promise.resolve(div[0])

	function 職業分類(a) {
		var r = 30, v = a.map(t=>t[0]), total = Math.SUM(v);
		const accumulate = (a) => { var n = 0; return a.map((t) => { n += (t == null)? 0: t; return n; }) };
		var svg = svgHead(-50,-45,100,90);
		var g = svgElem("g",{"text-anchor":"middle", "dominant-baseline":"middle", "font-size":4,"font-family":"Verdana",fill:fg});
		v = v.map(t=>t/total);
		var sum = accumulate(v), len = r*2*Math.PI;
		a.forEach((t, n)=>{ arc(sum[n]-v[n], v[n], t[2]);
			var rr = (0.5 - (sum[n] - v[n]/2))*Math.PI*2;
			v[n]>0.03 && svgElem("text", {x:r*Math.sin(rr),y:r*Math.cos(rr),fill:"#fff"},t[1]).appendTo(g);
		});
		g.appendTo(svg);
		svgElem("text", {x:0,y:-8, "font-size":6}, "対象者").appendTo(g);
		svgElem("text", {x:0,y:0, "font-size":6,"font-weight":700}, comma(total)).appendTo(g);
		svgElem("text", {x:0,y:8, "font-size":6}, "[人]").appendTo(g);
		function arc(start, v, cl) {
			svgElem("circle",{cx:0, cy:0, r:r, fill:"none", stroke:cl,"stroke-width":25,
			"stroke-dashoffset":(0.25 - start)*len, "stroke-dasharray":[v*len,(1-v)*len].join(",")}).appendTo(svg)
		}
		return svg.css({width:"75%"})
	}
	function 職業種類(a) { var div = $("<div class='legend'/>"); var total = Math.SUM(a.map(t=>t[0]));
		a.filter(t=>t[0]).forEach((t)=>{
			$("<div><span class='mark' style='background:"+t[2]+"'>"+t[1]+"</span><span>"+t[3]+"</span><span>"+pct(t[0]/total)+"</span></div>").appendTo(div);
		});
		return div;
	}
	function 地位分類(v) {
		const names = ["雇用者(役員を含む)","自営業主(家庭内職者を含む)","家族従業者"];
		var svg = svgHead(-5,-5,110,40);
		svgElem("rect",{x:0,y:0,width:100,height:15,fill:"#888"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:(v[1]+v[2]+v[3])*100/v[0],height:15,fill:"#0f8"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:(v[1]+v[2])*100/v[0],height:15,fill:"#8f0"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:(v[1])*100/v[0],height:15,fill:"#800"}).appendTo(svg)
		svgElem("rect",{x:0,y:0,width:100,height:15,fill:"none",stroke:fg, "stroke-width":1}).appendTo(svg);
		var g = svgElem("g",{"text-anchor":"middle", "dominant-baseline":"middle", "font-size":4,"font-family":"Verdana","fill":fg}).appendTo(svg);
		svgElem("path", {d:"M0,15v15M100,15v15M30,20v10M70,20v10", stroke:fg, "stroke-width":0.5}).appendTo(svg);
		svgElem("path", {d:"M30,20L"+(v[1])*100/v[0]+",15", stroke:fg, "stroke-width":0.5}).appendTo(svg);
		svgElem("path", {d:"M70,20L"+(v[1]+v[2])*100/v[0]+",15", stroke:fg, "stroke-width":0.5}).appendTo(svg);
		svgElem("text",{x:15,y:23},"自営業主").appendTo(g);
		svgElem("text",{x:50,y:23},"雇用者").appendTo(g);
		svgElem("text",{x:85,y:23},"家族従業者").appendTo(g);
		svgElem("text",{x:15,y:28},pct(v[1]/v[0])).appendTo(g);
		svgElem("text",{x:50,y:28},pct(v[2]/v[0])).appendTo(g);
		svgElem("text",{x:85,y:28},pct(v[3]/v[0])).appendTo(g);
		return svg;
	}
}

JADR.EXT = $.extend(JADR.EXT||{}, { 行政境界: {
	version: "260511-0000",
	dataUploaded: null, funcUpdated: null, reportUpdated: null,
	settings: {
	  loadObject: 町丁目データ[0]
	}
} });
function 行政境界TIP(d) {
  // 行政境界の TIP を表示を行う
	const code = REPLACE(d.properties.id), name = d.properties.name||"", area = d.properties.area||JADR.geometryArea(d.geometry);
	const areaName = code.length ==2? JADR.地域名称(code): code.length == 5? JADR.地域名称(code.substring(0,2))+JADR.地域名称(code): JADR.地域名称(code.substring(0,2))+JADR.地域名称(code.substring(0,5))+name;
	const div = $(ECDB.HTML("#base"));
	div.html(areaName);
	return div[0];
}

////=====================================================================================
function 町丁目(flag, opts) { const name = 町丁目データ[0];
	return flag === true?
	thenEachPref(pref=>JADR.shape2geo(MAP_URL(pref)).then(geo=>write(geo, pref))):
	JADR.loadFeaturesBy(name, opts.xprefs);
	function write(geo, pref) { var names = {}, a = {};
		JADR.flatten(geo).forEach(t=>{
			var g = t.geometry, prop = t.properties, id = prop.id = REPLACE(prop.KEY_CODE);
			names[id] = prop.S_NAME;
			a[id] = (a[id]||[]).concat(isMultiPolygon(g)?g.coordinates:[g.coordinates]);
		});
		a = Object.keys(a).map(t=>{
			var g = MultiPolygon(a[t]), bounds = JADR.geometry2boundary(g), area = JADR.geometryArea(g);
			return Feature(g, {id:t, name:names[t], bounds:bounds, area:area});
		});
		return JADR.saveFeatures(`${name}/${pref}`, JADR.shrinkFeatures(a, 0.4));
	}
}
// ** 町丁目連動データ(1/2) ** //
function 地域名11桁(flag) { const name = 町丁目データ[1];
	return flag === true? readAll().then(write):JADR.loadObject(name);
	function readAll() { var a = [];
		const 行政コード = n => ($.isString(n)? n: fillNum(n,n>999999999?11:n>99999?9:n>99?5:2));
		return thenEachPref(pref=>JADR.loadFeatures(`${町丁目データ[0]}/${pref}`).then(v=>{
			v = v.map(t=>{
				var p = t.properties;
				var id = REPLACE(行政コード(p.id)); if (id.length < 9) return;
				var name = JADR.数字化(JADR.新字変換(p.name||""), "(丁目|地割)")
				.replace(/大字/,"").replace(/^字/,"")
				.replace(/南10条/,"南十条").replace(/厚別東1条/,"厚別東一条").replace(/厚別北3条/,"厚別北三条");
				name = ({
				"072015010": "東中央1丁目","072015020": "東中央2丁目","072015030": "東中央3丁目",
				"072015040": "西中央1丁目","072015050": "西中央2丁目","072015060": "西中央3丁目",
				"072015070": "西中央4丁目","072015080": "西中央5丁目",
				"072015091": "南中央1丁目","072015092": "南中央1丁目",
				"072015100": "南中央2丁目",
				"072015110": "南中央3丁目",
				"072015121": "南中央4丁目","072015122": "南中央4丁目",
				"072015130": "北中央1丁目","072015140": "北中央2丁目"})[id]||name;
				return [id, name];
			}).filter(t=>t);
			a = a.concat(v);
		//	console.log(pref, v);
		})).then(()=>a);
	}
	function write(adr) {
		const L2 = n => (n>9?"":"0")+n;
		const fillNum = (n, len) => { n = "" + n; while (n.length < len) n = "0"+n; return n; };
		const 行政コード = n => ($.isString(n)? n: fillNum(n,n>999999999?11:n>99999?9:n>99?5:2));
		let tub = {};
		adr.forEach((t,i)=>{ var s = t[0];
			s = [s.substring(0,2),s.substring(2,5),s.substring(5,9),s.substring(9)];
			tub[s[0]] = tub[s[0]]||{};
			tub[s[0]][s[1]] = tub[s[0]][s[1]]||{};
			tub[s[0]][s[1]][s[2]] = tub[s[0]][s[1]][s[2]]||{};
			s[3]? (tub[s[0]][s[1]][s[2]][s[3]] = t[1]):(tub[s[0]][s[1]][s[2]]=t[1]);
		});
		$.each(tub,(s0,t)=>$.each(t,(s1,t)=>$.each(t,(s2,t)=>tub[s0][s1][s2] = $.isString(t)? t: conv(t))));
		adr.forEach(t=>{ var s = 地区名(t[0]); if (t[1] != s) console.warn(s+" <= "+t[1]); });
	//	console.log(tub);
		JADR.saveObject("地域名11桁",tub);
		function conv(q) {
			const o2a = o => { var a = []; $.each(o,(k,v)=>a[+k]=v); return a;};
			const a2o = (head, a) => { var o = {"":head}; a.forEach((t,i)=>o[L2(i)] = t||""); return o; };
			const num = s => s? +s.match(/(\d+)\D+$/)[1]: s;
			var a = o2a(q); if (!a.length) return "";
			var names = a.filter(t=>t!=null), name, head;
			name = unique(names.map(t=>t.replace(/\d+丁目$/,"_丁目")));
			if (name.length === 1 && name[0].match("_")) return a2o(name[0], a.map(num));
			name = unique(names.map(t=>t.replace(/\d+地割$/,"_地割")));
			if (name.length === 1 && name[0].match("_")) return a2o(name[0], a.map(num));
			head = names.shift()||"";
			names.forEach(t=>{while(head!=t.substring(0,head.length)) head = head.substring(0,head.length-1)});
			head = head.replace(/[字第\(]$/,"");//　if (head.length === 1) head = "";
			return a2o(head, a.map(t=>t? t.replace(head,""):t));
		}
		function 地区名(s) { s = 行政コード(s);
			s = [s.substring(0,2),s.substring(2,5),s.substring(5,9),s.substring(9)];
			try {
				var q = tub[s[0]][s[1]][s[2]]; if ($.isString(q)) return q;
				var base = q[""]||"", str = q[s[3]]||"";
				if (!s[3]) return base.replace(/(_丁目|第?_地割)/,"");
				return base.match(/_/)? base.replace("_", str): (base+str);
			} catch(e) { console.warn(s, q); return ""; }
		}
	}
}
// ** 町丁目連動データ(2/2) ** //
function 地域名MAP(flag) { const name = 町丁目データ[2];
	return flag === true? readAll().then(write):JADR.loadObject(name);
	function readAll() { var a = [];
		const fillNum = (n, len) => { n = "" + n; while (n.length < len) n = "0"+n; return n; };
		const 行政コード = n => ($.isString(n)? n: fillNum(n,n>999999999?11:n>99999?9:n>99?5:2));
		return thenEachPref(pref=>JADR.loadFeatures(`${町丁目データ[0]}/${pref}`).then(v=>{
			v = v.map(t=>{
				var p = t.properties;
				var id = REPLACE(行政コード(p.id)); if (id.length < 9) return;
				var name = JADR.数字化(JADR.新字変換(p.name||""), "(丁目|地割)")
				.replace(/南10条/,"南十条").replace(/厚別東1条/,"厚別東一条").replace(/厚別北3条/,"厚別北三条");
				name = ({
				"072015010": "東中央1丁目","072015020": "東中央2丁目","072015030": "東中央3丁目",
				"072015040": "西中央1丁目","072015050": "西中央2丁目","072015060": "西中央3丁目",
				"072015070": "西中央4丁目","072015080": "西中央5丁目",
				"072015091": "南中央1丁目","072015092": "南中央1丁目",
				"072015100": "南中央2丁目",
				"072015110": "南中央3丁目",
				"072015121": "南中央4丁目","072015122": "南中央4丁目",
				"072015130": "北中央1丁目","072015140": "北中央2丁目"})[id]||name;
				name = name.replace(/丁目$/,"").replace(/第?\d+地割$/,t=>t.replace(/\D/g,""));
				name = name.replace(/\(.*$/,"").replace(/大字/,"").replace(/字/,"")
				return [id.substring(0,2),id.substring(2,5),id.substring(5), JADR.名前単純化(name,pref)];
			}).filter(t=>t);
			a = a.concat(v);
			JADR.LOG(pref+":"+JADR.地域名称(pref));
		})).then(()=>a);
	}
	function write(adr) { let tub = {};
		adr.forEach(s=>{
			tub[s[0]] = tub[s[0]]||{};
			tub[s[0]][s[1]] = tub[s[0]][s[1]]||[];
			tub[s[0]][s[1]].push([s[3], s[2]]);
		});
	//	console.log(name,tub);
		JADR.saveObject(name,tub);
	}
}
function 町丁目名変換(t, unified) {
  if(!t || typeof t != 'string') {
    console.warn('町丁目名変換 強制的に、空文字に変換:', t);
    return '';
  }
  if(unified) {
    // TODO 地域名MAPのロジックを引き継ぐ
    t = JADR['数字化'](t);
    t = JADR['新字変換'](t);
  }
  const pairFix = ka=>ka.forEach(p=>t = t.replace(new RegExp(p[0], 'g'), String(p[1])));
  // 漢数字、全角数字を半角数字に統一
  let a = t.split('');
  const s2 = '０１２３４５６７８９';
  const s1 = '0123456789';
  ['丁目', '番地', '号'].forEach(x=>{
    const k10 = '一二三四五六七八九'.split('').map((c, i)=>[`十${c}${x}`, `${10 + i + 1}${x}`]).concat([ [`十${x}`, `10${x}`] ]);
    const k20 = '一二三四五六七八九'.split('').map((c, i)=>[`二十${c}${x}`, `${20 + i + 1}${x}`]).concat([ [`二十${x}`, `20${x}`] ]);
    const k30 = '一二三四五六七八九'.split('').map((c, i)=>[`三十${c}${x}`, `${30 + i + 1}${x}`]).concat([ [`三十${x}`, `30${x}`] ]);
    const k40 = '一二三四五六七八九'.split('').map((c, i)=>[`四十${c}${x}`, `${40 + i + 1}${x}`]).concat([ [`四十${x}`, `40${x}`] ]);
    const k0 = '〇一二三四五六七八九';
    [k40, k30, k20, k10].forEach(pairFix);
  });
  a = a.map(c=>{
    if((i = s2.indexOf(c)) == -1) return c;
    return s1[i];
  });
  return a.join('');
}
function 町丁目名最適(code, name) { name = name || '';
  const mtc = String(name).match(/(\D)(\d+)丁目$/);
  if(String(code || '00').length <= 9 || !mtc) return name;
  return name.replace(new RegExp(mtc[2] + '丁目$'), '');
}
////-----------------------------------------------------------------------------------------------
function 市区町村履歴(code) { var name = "市区町村履歴";
	return code === true? scripts("fr2HoldE")
	.then(()=>JADR.saveTSV(name, window[name])):
	JADR.loadTSV(name).then(v=>v.filter(t=>t[1]==code).map(t=>[""+t[0],t[2].replace(/\+/g,"\n")]));
}
////-----------------------------------------------------------------------------------------------
function 役所住所(code) { var name = "役所住所";
//斜里郡小清水町元町2-1-1 {code: "01547", string: "元町2-1-1"} (3) [0, 0, 2]
//さいたま市西区西大宮3-4-2 {code: "11101", string: "西大宮3-4-2"} (3) [0, 0, 2]
//青ヶ島村無番地 {code: "13402", string: "無番地"} (3) [0, 0, 2]
//那珂川市西隈1-1-1 {code: "40231", string: "西隈1-1-1"} (3) [0, 0, 2]
//黒川郡大和町吉岡まほろば1-1-1 {code: "04421", string: "吉岡まほろば1-1-1"} (3) [140.88462252, 38.4454551, 2]
//東田川郡庄内町余目字町132-1 {code: "06428", string: "余目字町132-1"} (3) [139.90774494, 38.84635922, 2]
//伊達郡国見町藤田字1丁田二1-7 {code: "07303", string: "藤田字1丁田二1-7"} (3) [140.54388486, 37.87485849, 2]
//横浜市泉区和泉中央北5-1-1 {code: "14116", string: "和泉中央北5-1-1"} (3) [139.49594084, 35.41858713, 2]
////-----------------------------------------------------------------------------------------------
//中川郡豊頃町茂岩本町125 {code: "01645", string: "茂岩本町125"} (3) [143.50713467, 42.80073183, 1]
//宮城郡松島町高城字帰命院下一19-1 {code: "04401", string: "高城字帰命院下一19-1"} (3) [141.06940975, 38.38199731, 1]
//加美郡加美町西田3-5 {code: "04445", string: "西田3-5"} (3) [140.85728094, 38.57154525, 1]
//西白河郡泉崎村泉崎字八丸145 {code: "07464", string: "泉崎字八丸145"} (3) [140.30323369, 37.15304411, 1]
//戸田市上戸田1-18-1 {code: "11224", string: "上戸田1-18-1"} (3) [139.67237807, 35.82205866, 1]
//習志野市鷺沼2-1-1 {code: "12216", string: "鷺沼2-1-1"} (3) [140.0266783, 35.68173766, 1]
//豊島区南池袋2-45-1 {code: "13116", string: "南池袋2-45-1"} (3) [139.71651606, 35.72621165, 1]
//藤沢市朝日町1-1 {code: "14205", string: "朝日町1-1"} (3) [139.49166598, 35.33973348, 1]
//南都留郡道志村6181-1 {code: "19422", string: "6181-1"} (3) [139.02189812, 35.49261028, 1]
//北安曇郡小谷村中小谷丙131 {code: "20486", string: "中小谷丙131"} (3) [137.91178774060762, 36.795230880235465, 1]
//蒲生郡日野町河原1-1 {code: "25383", string: "河原1-1"} (3) [136.25419121, 35.02487516, 1]
//堺市中区深井沢町2470-7 {code: "27142", string: "深井沢町2470-7"} (3) [135.49858872, 34.5283944, 1]
//高石市加茂4-1-1 {code: "27225", string: "加茂4-1-1"} (3) [135.44160779, 34.52094169, 1]
//邑智郡川本町川本271-3 {code: "32441", string: "川本271-3"} (3) [132.49580416, 34.99489112, 1]
//浅口市鴨方町六条院中3050 {code: "33216", string: "鴨方町六条院中3050"} (3) [133.58378485, 34.53178264, 1]
//小豆郡土庄町甲559-2 {code: "37322", string: "甲559-2"} (3) [134.18130904, 34.48480808, 1]
//幡多郡黒潮町入野5893 {code: "39428", string: "入野5893"} (3) [133.00615842, 33.0272879, 1]
//遠賀郡岡垣町野間1-1-1 {code: "40383", string: "野間1-1-1"} (3) [130.61264341, 33.84003952, 1]
//阿蘇郡南阿蘇村河陽1705-1 {code: "43433", string: "河陽1705-1"} (3) [131.01811043, 32.84414866, 1]
//上益城郡益城町木山594 {code: "43443", string: "木山594"} (3) [130.81567033, 32.80029571, 1]
//#inline("662JNMse");
	const fix = (n, decimal) => ECDB.Comma(n.toFixed(decimal||0));
	const 役場 = s => s.match(/(町|村)$/)? s+"役場": s.match(/^(.*市)(.*区)$/)? s.replace(/^.*市/,"")+"役所":s.match(/(市|区)$/)? s+"役所":s+"庁"; 
	const dom = a => a? "<div class='admin'>"+
		"<span class='name'>"+役場(a[1])+"</span>"+
		"<span class='tel'>"+a[4]+"</span>"+"<button onclick=\"window.open('"+a[6]+"','_wiki_')\"> HP </button>"+"<br/>"+
		"<span class='zip'>〒"+a[2]+"</span>"+ "<span class='adr'>"+(JADR.地域名称(a[3])+a[4])+"</span>"+"</div>":"";
	return code === true? scripts("662JNMse")
	.then(()=>{ var a = [];
		return thenEach(window[name], t=>JADR.str2pos(t[3]).then(pos=>{
			let adr = JADR.str2adr(t[3]);
			pos = t[6]||pos;
			pos[2] && console.log(t[3], adr, pos);
			a.push([t[0],t[1],t[2],adr.code,adr.string,t[4],t[5],pos]);
		})).then(()=>JADR.saveObject(name, a));
	}):
	JADR.loadObject(name).then(list=>{
		var a = [list.filter(t=>t[0]===code)[0]];
		if (code.length == 5 && a[0]) {
			var r = a[0][1].match(/^(.*市)(.*区)$/);
			r && a.push(list.filter(t=>t[1]===r[1])[0]);
			a.push(list.filter(t=>t[0]===code.substring(0,2))[0]);
		} else { console.warn("code: ", code)}
		return a.map(dom).join("");
	})
};
