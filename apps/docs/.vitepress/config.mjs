import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
	base: "/docs",
	title: "Ortho Earth - Docs",
	description: "A modern orthographic map renderer.",
	head: [
		['link', { rel: 'icon', type: 'image/svg+xml', href: '/docs/favicon.svg' }],
		['script', {}, `
(function() {
      // 1. 保護したい固有名詞リスト
      const PROTECT_WORDS = ['ortho earth', 'ortho-earth', 'geopbf', 'altpbf', 'native-bucket'];

      function applyGuard() {
        // 2. サブページ特有のクラス（サイドバー、ナビバー、パンくずなど）を網羅
        const selectors = [
    '.VPNavBarTitle .title',   // 左上のサイト名
    '.VPNavBarMenuLink',       // ナビゲーション
    '.VPSidebarItem .text',    // サイドバーのメニュー項目
    '.VPBreadcrumbs .item',    // パンくずリスト
    '.VPButton',               // ボタン
    '.VPHero .name',           // ヒーローセクションのタイトル
    '.VPFeature .title',       // フィーチャーのタイトル
    '.pager-link .title',      // 🌟 追加：次へ/前へリンク内のページタイトル
    'h1, h2, h3'               // 各ページの見出し
  ].join(',');

        document.querySelectorAll(selectors).forEach(el => {
          const content = el.innerText.toLowerCase();
          if (PROTECT_WORDS.some(word => content.includes(word))) {
            // 3. 翻訳拒否属性とクラスを付与
            if (el.getAttribute('translate') !== 'no') {
              el.setAttribute('translate', 'no');
              el.classList.add('notranslate');
            }
          }
        });
      }

      // 4. ページ読み込み完了時と、DOMが動的に書き換わった時に即座に実行
      window.addEventListener('DOMContentLoaded', applyGuard);
      
      // VitePressのSPA遷移（部品の差し替え）を監視
      const observer = new MutationObserver((mutations) => {
        applyGuard();
      });

      observer.observe(document.documentElement, { 
        childList: true, 
        subtree: true,
        attributes: false // 速度向上のため属性変化は追わない
      });
    })();
		`]
	],
	themeConfig: {
			// https://vitepress.dev/reference/default-theme-config
		nav: [
			{ text: 'home', link: '/' },
			{ text: 'www', link: '../', target: '_self' },
		//	{ text: 'Examples', link: '/markdown-examples' }
		],
		sidebar: [
			{	text: 'Packages',
				items: [
					{ text: 'ortho-earth', link: '/ortho-earth' },
					{ text: 'geopbf', link: '/geopbf' },
					{ text: 'altpbf', link: '/altpbf' },
					{ text: 'native-bucket', link: '/native-bucket' }
				]
      		}
		],
		socialLinks: [
			{ icon: 'github', link: 'https://github.com/kenjiyoshidahome2026-bit/ortho-earth' }
		]
	}
})
