import json,math,collections
fc=json.load(open('nps_all.geojson'))
TOL=0.0005
def dp(pts,tol):
    if len(pts)<5: return pts
    keep=[False]*len(pts); keep[0]=keep[-1]=True
    st=[(0,len(pts)-1)]
    while st:
        a,b=st.pop();ax,ay=pts[a];bx,by=pts[b];dx,dy=bx-ax,by-ay;L=dx*dx+dy*dy;mx=-1;mi=-1
        for i in range(a+1,b):
            px,py=pts[i]
            if L==0: d=math.hypot(px-ax,py-ay)
            else: t=max(0,min(1,((px-ax)*dx+(py-ay)*dy)/L)); d=math.hypot(px-ax-t*dx,py-ay-t*dy)
            if d>mx: mx=d;mi=i
        if mx>tol: keep[mi]=True; st.append((a,mi)); st.append((mi,b))
    return [p for p,k in zip(pts,keep) if k]
def sarea(r):
    s=0
    for i in range(len(r)-1): s+=r[i][0]*r[i+1][1]-r[i+1][0]*r[i][1]
    return s/2
def pip(pt,r):
    x,y=pt;ins=False
    for i in range(len(r)-1):
        x1,y1=r[i];x2,y2=r[i+1]
        if (y1>y)!=(y2>y) and x<(x2-x1)*(y-y1)/(y2-y1)+x1: ins=not ins
    return ins
parks=collections.defaultdict(list)
for f in fc['features']:
    g=f['geometry'];polys=g['coordinates'] if g['type']=='MultiPolygon' else [g['coordinates']]
    for poly in polys: parks[f['properties']['名称']].append(poly)
out=[];stats=[]
for name,polys in parks.items():
    # 1) 共有辺の相殺（整数化キー）
    K=lambda p:(round(p[0]*1e6),round(p[1]*1e6))
    edges={}
    for poly in polys:
        for ring in poly:
            for i in range(len(ring)-1):
                a,b=K(ring[i]),K(ring[i+1])
                if a==b: continue
                if (b,a) in edges: del edges[(b,a)]
                else: edges[(a,b)]=edges.get((a,b),0)+1
    # 2) 残った辺を環に繋ぐ
    nxt=collections.defaultdict(list)
    for (a,b) in edges: nxt[a].append(b)
    rings=[]
    used=set()
    for (a,b) in list(edges):
        if (a,b) in used: continue
        ring=[a];cur=a;prev=None
        while True:
            cands=[c for c in nxt[cur] if (cur,c) not in used]
            if not cands: break
            # 分岐点は直前の進行方向から最も右に曲がる辺を選ぶ（外周を保つ）
            if len(cands)>1 and prev is not None:
                def ang(c):
                    v1=(cur[0]-prev[0],cur[1]-prev[1]);v2=(c[0]-cur[0],c[1]-cur[1])
                    return -math.atan2(v1[0]*v2[1]-v1[1]*v2[0], v1[0]*v2[0]+v1[1]*v2[1])
                cands.sort(key=ang)
            c=cands[0];used.add((cur,c));ring.append(c);prev,cur=cur,c
            if cur==a: break
        if len(ring)>3 and ring[0]==ring[-1]: rings.append([[x/1e6,y/1e6] for x,y in ring])
    # 3) 間引き・極小を捨てる
    rs=[]
    for r in rings:
        A=abs(sarea(r))
        if A<(TOL*3)**2: continue
        s=dp(r,TOL)
        if len(s)>=4 and abs(sarea(s))>0: rs.append(s)
    # 4) 入れ子（偶数深さ=外周・奇数=穴）
    depth=[]
    for i,r in enumerate(rs):
        d=sum(1 for j,o in enumerate(rs) if j!=i and abs(sarea(o))>abs(sarea(r)) and pip(r[0],o))
        depth.append(d)
    outers=[(i,r) for i,r in enumerate(rs) if depth[i]%2==0]
    polysOut=[]
    for i,r in outers:
        if sarea(r)<0: r=r[::-1]
        holes=[]
        for j,h in enumerate(rs):
            if depth[j]==depth[i]+1 and pip(h[0],r):
                holes.append(h if sarea(h)<0 else h[::-1])
        polysOut.append([r]+holes)
    nv=sum(len(x) for p in polysOut for x in p)
    stats.append((name,len(polys),len(rings),len(rs),len(polysOut),nv))
    out.append({"type":"Feature","properties":{"name":name},"geometry":{"type":"MultiPolygon","coordinates":polysOut}})
for s in stats: print(s)
print('total vertices',sum(s[-1] for s in stats))
json.dump({"type":"FeatureCollection","features":out},open('parks-boundary.geojson','w'),ensure_ascii=False)
