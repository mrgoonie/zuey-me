import json,glob,sys,statistics,os
d=sys.argv[1]; rows={}
for f in glob.glob(d+'/*.json'):
    n,ff,i=os.path.basename(f)[:-5].rsplit('-',2)
    j=json.load(open(f)); a=j['audits']
    rows.setdefault((n,ff),[]).append((j['categories']['performance']['score']*100,a['largest-contentful-paint']['numericValue'],a['cumulative-layout-shift']['numericValue'],a['total-blocking-time']['numericValue'],a['first-contentful-paint']['numericValue']))
print('| page | form | perf | LCP ms | CLS | TBT ms | FCP ms | runs |\n|---|---|---|---|---|---|---|---|')
for (n,ff),v in sorted(rows.items()):
    med=lambda k: statistics.median([x[k] for x in v])
    print(f'| {n} | {ff} | {med(0):.0f} | {med(1):.0f} | {med(2):.3f} | {med(3):.0f} | {med(4):.0f} | {len(v)} |')
