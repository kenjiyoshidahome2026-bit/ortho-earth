// 頁の型の補い：Safari の旧名 webkitAudioContext（src/sound.ts）・検定の注入口 window.__orthoEngine（src/mapview.ts＝偽エンジン）
interface Window { webkitAudioContext?: typeof AudioContext; __orthoEngine?: typeof import("@ortho-earth/globe") }
