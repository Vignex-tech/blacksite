import sys,json,struct
b=open(sys.argv[1],'rb').read(); l=struct.unpack('<I',b[12:16])[0]; j=json.loads(b[20:20+l])
print('size',len(b),'meshes',[m.get('name') for m in j.get('meshes',[])],'skins',len(j.get('skins',[])),'joints',[len(s['joints']) for s in j.get('skins',[])])
tri=0
for m in j.get('meshes',[]):
    for p in m['primitives']:
        if 'indices' in p: tri+=j['accessors'][p['indices']]['count']//3
print('tris',tri,'images',len(j.get('images',[])),'materials',[m.get('name') for m in j.get('materials',[])])
print('anims',[a['name'] for a in j.get('animations',[])])
