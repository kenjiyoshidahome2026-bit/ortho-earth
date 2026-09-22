export function initSidebarToggle() {
    const app      = document.getElementById('app');
    const toggle   = document.getElementById('sidebar-toggle');
    const openBtn  = document.getElementById('sidebar-open-btn');
    const backdrop = document.getElementById('sidebar-backdrop');

    const isMobile = () => window.innerWidth <= 640;
    const saved = () => { try { return localStorage.getItem('sidebar-collapsed') === '1'; } catch { return false; } };

    // ボタンの中身（menu.svg）は触らない＝旧は textContent に ▶/◀ を入れてアイコンを消していた。状態は aria で示す
    function setSidebarCollapsed(collapsed, remember = true) {
        app.classList.toggle('sidebar-collapsed', collapsed);
        toggle.setAttribute('aria-label', collapsed ? 'サイドバーを開く' : 'サイドバーを折りたたむ');
        toggle.setAttribute('aria-expanded', String(!collapsed));
        if (remember && !isMobile()) { try { localStorage.setItem('sidebar-collapsed', collapsed ? '1' : '0'); } catch {} }
    }

    setSidebarCollapsed(isMobile() || saved(), false);

    toggle.addEventListener('click', () => setSidebarCollapsed(!app.classList.contains('sidebar-collapsed')));
    openBtn?.addEventListener('click',  () => setSidebarCollapsed(false));
    backdrop?.addEventListener('click', () => setSidebarCollapsed(true));

    document.getElementById('dataset-list').addEventListener('click', e => {
        if (isMobile() && e.target.closest('.ds-item')) setSidebarCollapsed(true);
    });

    // 幅の段（モバイル⇄デスクトップ）を跨いだ時だけ状態を決め直す（旧＝resize の度に上書き＝スマホの回転で開いたサイドバーが閉じた）
    let wasMobile = isMobile();
    window.addEventListener('resize', () => {
        const m = isMobile();
        if (m === wasMobile) return;
        wasMobile = m;
        setSidebarCollapsed(m || saved(), false);
    });

    return { open: () => setSidebarCollapsed(false) };
}
