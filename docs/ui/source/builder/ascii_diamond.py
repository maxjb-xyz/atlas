import sys
W, H = int(sys.argv[1]), int(sys.argv[2])
top=(0.5,0.0); left=(0.0,0.377); right=(1.0,0.377); bot=(0.5,1.0); c=(0.5,0.493)
def sign(p,a,b): return (p[0]-b[0])*(a[1]-b[1])-(a[0]-b[0])*(p[1]-b[1])
def intri(p,a,b,cc):
    d1,d2,d3=sign(p,a,b),sign(p,b,cc),sign(p,cc,a)
    neg=(d1<0) or (d2<0) or (d3<0); pos=(d1>0) or (d2>0) or (d3>0)
    return not (neg and pos)
facets=[(top,left,c,'@'),(top,c,right,'%'),(bot,left,c,'*'),(bot,c,right,'+')]
layers=[[[' ']*W for _ in range(H)] for _ in range(4)]
for r in range(H):
    for col in range(W):
        p=((col+0.5)/W,(r+0.5)/H)
        for i,(a,b,cc,ch) in enumerate(facets):
            if intri(p,a,b,cc):
                # leave a gap along the seams for the mark's facet lines
                layers[i][r][col]=ch; break
for i in range(4):
    print('\n'.join(''.join(row).rstrip() for row in layers[i]))
    print('=====')
