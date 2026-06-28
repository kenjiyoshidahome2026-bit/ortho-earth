export function initSidebarToggle() {
    const app      = document.getElementById('app');
    const toggle   = document.getElementById('sidebar-toggle');
    const openBtn  = document.getElementById('sidebar-open-btn');
    const backdrop = document.getElementById('sidebar-backdrop');

    const isMobile = () => window.innerWidth <= 640;

    if (!isMobile() && localStorage.getItem('sidebar-collapsed') === '1') {
        app.classList.add('sidebar-collapsed');
        toggle.textContent = '▶';
    }
    if (isMobile()) {
        app.classList.add('sidebar-collapsed');
    }

    function setSidebarCollapsed(collapsed) {
        app.classList.toggle('sidebar-collapsed', collapsed);
        if (!isMobile()) localStorage.setItem('sidebar-collapsed', collapsed ? '1' : '0');
    }

    toggle.addEventListener('click', () => setSidebarCollapsed(!app.classList.contains('sidebar-collapsed')));
    openBtn?.addEventListener('click',  () => setSidebarCollapsed(false));
    backdrop?.addEventListener('click', () => setSidebarCollapsed(true));

    document.getElementById('dataset-list').addEventListener('click', e => {
        if (isMobile() && e.target.closest('.ds-item')) setSidebarCollapsed(true);
    });

    window.addEventListener('resize', () => {
        if (!isMobile()) {
            const saved = localStorage.getItem('sidebar-collapsed') === '1';
            setSidebarCollapsed(saved);
            toggle.textContent = saved ? '▶' : '◀';
        } else {
            app.classList.add('sidebar-collapsed');
            toggle.textContent = '◀';
        }
    });
}
