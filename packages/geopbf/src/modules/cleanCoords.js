export function cleanCoords(pts) {
    if (pts.length < 3) return pts;
    const eps = 1e-9, q = [];
    const ccw = (a, b, c) => (c[1] - a[1]) * (b[0] - a[0]) - (c[0] - a[0]) * (b[1] - a[1]);
    
    for (let p of pts) {
        while (q.length >= 2) {
            const [a, b] = [q[q.length-2], q[q.length-1]];
            const [v1, v2] = [[b[0]-a[0], b[1]-a[1]], [p[0]-b[0], p[1]-b[1]]];
            if (Math.abs(v1[0]*v2[1] - v1[1]*v2[0]) < eps && v1[0]*v2[0] + v1[1]*v2[1] <= 0) q.pop();
            else break;
        }
        if (!q.length || Math.hypot(q[q.length-1][0]-p[0], q[q.length-1][1]-p[1]) > eps) q.push(p);
    }
    
    for (let i = 0; i < q.length - 3; i++) {
        for (let j = 2; j <= 3 && i + j + 1 < q.length; j++) {
            const [p1, p2, p3, p4] = [q[i], q[i+1], q[i+j], q[i+j+1]];
            if (ccw(p1,p2,p3) * ccw(p1,p2,p4) < 0 && ccw(p3,p4,p1) * ccw(p3,p4,p2) < 0) {
                q.splice(i + 1, j); i = -1; break;
            }
        }
    }

    // 修正箇所: q が空の場合は安全に終了
    if (q.length === 0) return []; 

    const [f, l] = [q[0], q[q.length-1]]; 
    if (f[0] === l[0] && f[1] === l[1]) q.pop(); 
    
    if (q.length > 2) { 
        const [a, b, c] = [q[q.length-1], q[0], q[1]];
        const [v1, v2] = [[b[0]-a[0], b[1]-a[1]], [c[0]-b[0], c[1]-b[1]]];
        if (Math.abs(v1[0]*v2[1] - v1[1]*v2[0]) < eps && v1[0]*v2[0] + v1[1]*v2[1] <= 0) q.shift();
    }
    
    // 修正箇所: 要素が残っている場合のみ閉じる
    if (q.length > 0) q.push([...q[0]]); 
    return q;
}