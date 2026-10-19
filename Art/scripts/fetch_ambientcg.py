"""Download ambientCG material zips (CC0) by asset id.

Usage: python -I Art/scripts/fetch_ambientcg.py <fresh empty output dir> <assetId> [<assetId> ...] [--res 1K-JPG]
Uses the public API https://ambientcg.com/api/v2/full_json. The zips are untrusted data: extract each into its own
new empty folder and copy only the image files you need.
"""
import sys, os, json, urllib.request

args = sys.argv[1:]
res = '1K-JPG'
if '--res' in args:
    i = args.index('--res'); res = args[i + 1]; del args[i:i + 2]
out, ids = args[0], args[1:]
if os.path.exists(out) and os.listdir(out):
    sys.exit('output dir must be new and empty: ' + out)
os.makedirs(out, exist_ok=True)
for a in ids:
    meta = json.load(urllib.request.urlopen('https://ambientcg.com/api/v2/full_json?id=%s&include=downloadData' % a))
    asset = meta['foundAssets'][0]
    for dl in asset['downloadFolders']['default']['downloadFiletypeCategories']['zip']['downloads']:
        if dl['attribute'] == res:
            req = urllib.request.Request(dl['downloadLink'], headers={'User-Agent': 'Mozilla/5.0'})
            open(os.path.join(out, dl['fileName']), 'wb').write(urllib.request.urlopen(req).read())
            print('saved', dl['fileName'])
