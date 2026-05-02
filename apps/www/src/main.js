import './style.css';
// import { initOrthoMap } from 'ortho-map'; // パッケージ化・切り出し後にインポートします

document.addEventListener('DOMContentLoaded', () => {
  console.log('✨ Ortho Map Homepage Loaded');

  const btnDemo = document.getElementById('btn-demo');
  const btnDocs = document.getElementById('btn-docs');
  const heroSection = document.querySelector('.hero');

  // 「Launch Demo」ボタンを押したときのアクション
  btnDemo.addEventListener('click', () => {
    // ヒーローセクションをフェードアウトさせて地図を全画面で見せる演出
    heroSection.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    heroSection.style.opacity = '0';
    heroSection.style.transform = 'translateY(-20px)';
    heroSection.style.pointerEvents = 'none';

    // ここで ortho-map を #map-container に描画・アクティブにする処理を呼ぶ
    // initOrthoMap(document.getElementById('map-container'));
    
    console.log('Demo started! The UI is hidden to show the map.');
  });

  btnDocs.addEventListener('click', () => {
    window.location.href = '#docs';
  });

  // （モック）背景になんとなく地図っぽいものを描画して待機するなどの初期化処理
  const mapContainer = document.getElementById('map-container');
  // mapContainer.innerHTML = `<canvas></canvas>`; 
});