import json, re, unicodedata, collections, sys
SRC='/tmp/phx/node_modules/@jobuntux/psgc/data/2025-2Q/'
R=json.load(open(SRC+'regions.json')); P=json.load(open(SRC+'provinces.json')); M=json.load(open(SRC+'muncities.json')); B=json.load(open(SRC+'barangays.json'))
ZA=json.load(open('/tmp/phx/pzx/phzipcodes/data/ph_zip_codes.json'))
ZB=json.load(open('/tmp/phx/node_modules/zipcodes-ph/build/zipcodes.json'))
clean=lambda s: re.sub(r'\s+',' ',(s or '').strip())
def norm(s):
    s=unicodedata.normalize('NFKD',clean(s).lower()); s=''.join(c for c in s if not unicodedata.combining(c))
    s=re.sub(r'\(.*?\)','',s)
    s=re.sub(r'\bsta\.?\s','santa ',s); s=re.sub(r'\bsto\.?\s','santo ',s); s=re.sub(r'\bgen\.?\s','general ',s); s=re.sub(r'\bpres\.?\s','president ',s)
    s=re.sub(r'^city of\s+','',s); s=re.sub(r'\s+city$','',s); s=re.sub(r'\bcity\b','',s)
    s=re.sub(r'[^a-z0-9]+',' ',s).strip(); return s
reg={r['regCode']:clean(r['regionName']) for r in R}
prov={p['provCode']:p for p in P}
HUC_PROV={'City of Angeles':'Pampanga','City of Bacolod':'Negros Occidental','City of Baguio':'Benguet','City of Butuan':'Agusan del Norte',
 'City of Cagayan De Oro':'Misamis Oriental','City of Cebu':'Cebu','City of Lapu-Lapu':'Cebu','City of Mandaue':'Cebu','City of Davao':'Davao del Sur',
 'City of General Santos':'South Cotabato','City of Iligan':'Lanao del Norte','City of Iloilo':'Iloilo','City of Lucena':'Quezon','City of Olongapo':'Zambales',
 'City of Puerto Princesa':'Palawan','City of Tacloban':'Leyte','City of Zamboanga':'Zamboanga del Sur'}
def city_label(n):
    n=clean(n)
    m=re.match(r'^City of (.+)$',n)
    return f'{m.group(1)} City' if m else n
MANILA_DISTRICT={'Tondo I/II':'Tondo'}
# ---- geographic province of each city/municipality
places=[]  # (regionName, provinceName, cityCode, cityLabel, psgcName)
for m in M:
    code=m['munCityCode']; name=clean(m['munCityName']); rc=m['regCode']; pc=m['provCode']
    if rc=='13':
        if name=='City of Manila': continue
        pname='Metro Manila'
        label = f"Manila ({MANILA_DISTRICT.get(name,name)})" if pc=='806' else city_label(name)
    elif pc in prov and prov[pc]['cityClass']:
        pname=HUC_PROV[clean(prov[pc]['provName'])]; label=city_label(name)
    elif pc=='901': pname='Basilan'; label=city_label(name)
    elif pc=='999': pname='Special Geographic Area'; label=name
    else: pname=clean(prov[pc]['provName']); label=city_label(name)
    places.append(dict(region=reg[rc], rc=rc, province=pname, code=code, label=label, name=name))
# ---- ZIP codes
zips=collections.defaultdict(list)    # code -> [(zip, area)]
provz=collections.defaultdict(list)   # province -> zips (for ranges)
# A: province-labelled list (PHLPost scrape)
def pnorm(s): return norm(re.sub(r'\(.*?\)','',s)).replace(' de ',' del ') if s else ''
A={}
for r,ps in ZA.items():
    for p,cs in ps.items():
        if not p or 'Metro Manila' in p: continue
        for c,zl in cs.items(): A.setdefault(pnorm(p),{}).setdefault(norm(c),set()).update(z for z in zl if re.fullmatch(r'\d{4}',z))
# B: zip -> name(s)
Bn=collections.defaultdict(list)
for z,v in ZB.items():
    for nm in (v if isinstance(v,list) else [v]):
        for part in re.split(r'/',nm): Bn[norm(part)].append(z)
nonncr=[p for p in places if p['rc']!='13']
src=collections.Counter()
for p in nonncr:
    hit=A.get(pnorm(p['province']),{}).get(norm(p['name'])) or A.get(pnorm(p['province']),{}).get(norm(p['label']))
    if hit:
        zips[p['code']]=[(z,'') for z in sorted(hit)]; provz[p['province']].extend(hit); src['A']+=1
# province ranges from A + unique B
for p in nonncr:
    if zips[p['code']]: continue
    c=Bn.get(norm(p['name']),[])
    if len(c)==1 and sum(1 for q in nonncr if norm(q['name'])==norm(p['name']))==1: provz[p['province']].append(c[0])
def prange(pr):
    zs=sorted(int(z) for z in provz.get(pr,[]))
    if not zs: return None
    med=zs[len(zs)//2]; zs=[z for z in zs if abs(z-med)<=150]
    return (min(zs)-5,max(zs)+5)
for p in nonncr:
    if zips[p['code']]: continue
    cands=Bn.get(norm(p['name']),[])
    if not cands: continue
    same=[q for q in nonncr if norm(q['name'])==norm(p['name'])]
    rg=prange(p['province'])
    pick=[z for z in cands if rg and rg[0]<=int(z)<=rg[1]] if (len(same)>1 or len(cands)>1) else cands
    if len(same)==1 and not pick and len(cands)==1: pick=cands
    if pick: zips[p['code']]=[(z,'') for z in sorted(set(pick))]; src['B']+=1
# fuzzy pass for spelling differences (Ozamiz/Ozamis, Daanbantayan/Daang-Bantayan), only within the province's ZIP range
import difflib
allB=list(Bn.items())
for p in nonncr:
    if zips[p['code']]: continue
    rg=prange(p['province'])
    if not rg: continue
    n=norm(p['name']).replace(' ','')
    best=None
    for bn,zl in allB:
        inr=[z for z in zl if rg[0]<=int(z)<=rg[1]]
        if not inr: continue
        r=difflib.SequenceMatcher(None,n,bn.replace(' ','')).ratio()
        if r>=0.84 and (not best or r>best[0]): best=(r,inr,bn)
    if best:
        taken=any(best[1][0]==z for q in nonncr for z,_ in zips[q['code']])
        if not taken: zips[p['code']]=[(z,'') for z in sorted(set(best[1]))]; src['fuzzy']+=1
# NCR
NCR_RANGES=[('Quezon City',1100,1138),('Makati City',1200,1235),('Pasay City',1300,1309),('Caloocan City',1400,1428),('Valenzuela City',1440,1469),
 ('Malabon City',1470,1480),('Navotas City',1485,1490),('San Juan City',1500,1504),('Mandaluyong City',1550,1556),('Pasig City',1600,1612),('Pateros',1620,1621),
 ('Taguig City',1630,1639),('Parañaque City',1700,1720),('Las Piñas City',1740,1752),('Muntinlupa City',1770,1799),('Marikina City',1800,1812)]
MANILA={'1000':'Ermita','1001':'Quiapo','1002':'Intramuros','1003':'Santa Cruz','1014':'Santa Cruz','1004':'Malate','1005':'San Miguel','1006':'Binondo','1007':'Paco',
 '1008':'Sampaloc','1015':'Sampaloc','1016':'Sampaloc','1009':'Santa Ana','1017':'Santa Ana','1010':'San Nicolas','1011':'Pandacan','1012':'Tondo','1013':'Tondo','1018':'Port Area'}
ncr_area=collections.defaultdict(list)
for name,zl in ZA['NCR (National Capital Region)']['Metro Manila'].items():
    for z in zl:
        if name not in ncr_area[z]: ncr_area[z].append(clean(name))
for z in MANILA:
    if z not in ncr_area:
        b=ZB.get(z); ncr_area[z].append(b if isinstance(b,str) else MANILA[z])
bylabel={p['label']:p for p in places if p['rc']=='13'}
for z,areas in sorted(ncr_area.items()):
    zi=int(z); target=None
    if z in MANILA: target=f'Manila ({MANILA[z]})'
    else:
        for n,a,b in NCR_RANGES:
            if a<=zi<=b: target=n
    if target and target in bylabel:
        area=', '.join(dict.fromkeys(a for a in areas if not re.search(r'P\.?O\.? Box',a, re.I)))
        zips[bylabel[target]['code']].append((z,area[:60]))
    elif target: print('NCR target missing', target, file=sys.stderr)
# Freeport zones have their own ZIP codes; offer them in the cities they sit in.
EXTRA={('Angeles City','Pampanga'):[('2023','Clark Freeport Zone')],('Mabalacat City','Pampanga'):[('2023','Clark Freeport Zone')],
       ('Olongapo City','Zambales'):[('2222','Subic Bay Freeport Zone')]}
for p in places:
    for (lab,pr),extra in EXTRA.items():
        if p['label']==lab and p['province']==pr:
            have={z for z,_ in zips[p['code']]}
            zips[p['code']]=[(z,'') for z,_ in zips[p['code']]]+[e for e in extra if e[0] not in have]
# ---- output
regions=collections.OrderedDict()
for r in R: regions[clean(r['regionName'])]=collections.OrderedDict()
for p in places:
    regions[p['region']].setdefault(p['province'],[]).append(p)
out={'source':'PSGC 2025-2Q (Philippine Statistics Authority); ZIP codes from the PHLPost ZIP code directory','regions':[]}
nat=lambda s:[int(t) if t.isdigit() else t.lower() for t in re.split(r'(\d+)',s)]
for rn,provs in regions.items():
    out['regions'].append({'n':rn,'p':[{'n':pn,'c':[{'id':c['code'],'n':c['label'],'z':[[z,a] if a else [z] for z,a in sorted(set(zips[c['code']]))]} for c in sorted(cs,key=lambda c:nat(c['label']))]} for pn,cs in sorted(provs.items())]})
brgy=collections.defaultdict(list)
for b in B: brgy[b['munCityCode']].append(clean(b['brgyName']))
for k in brgy: brgy[k]=sorted(set(brgy[k]),key=nat)
json.dump(out,open('/tmp/phx/build/ph-locations.json','w'),ensure_ascii=False,separators=(',',':'))
json.dump(brgy,open('/tmp/phx/build/ph-barangays.json','w'),ensure_ascii=False,separators=(',',':'))
total=len(places); withz=sum(1 for p in places if zips[p['code']])
print('places',total,'with zip',withz, f'{withz/total:.1%}', dict(src), 'NCR cities', sum(1 for p in places if p['rc']=='13'))
miss=[f"{p['label']} ({p['province']})" for p in places if not zips[p['code']]]
print('missing sample', miss[:60])
