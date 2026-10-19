"""Download the free uploads of an itch.io "name your own price" asset page.

Usage: python -I Art/scripts/fetch_itch.py <itch page url> <fresh empty output dir> [regex of upload names]
With no regex it only lists the uploads. The output dir must be a NEW, EMPTY folder outside the repo
(downloads are untrusted data). Nothing is executed or extracted here. Only free uploads are reachable;
paid tiers (Pro, Source) are not downloaded.
"""
import sys, re, json, os, urllib.request, urllib.parse, http.cookiejar

page, out = sys.argv[1].rstrip('/'), sys.argv[2]
rx = sys.argv[3] if len(sys.argv) > 3 else None
if os.path.exists(out) and os.listdir(out):
    sys.exit('output dir must be new and empty: ' + out)
os.makedirs(out, exist_ok=True)
cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def get(u, data=None):
    return op.open(urllib.request.Request(u, data=data, headers={'User-Agent': 'Mozilla/5.0'})).read()

def tok(h):
    return re.search(r'csrf_token" value="([^"]+)"', h).group(1)

h = get(page).decode()
d = json.loads(get(page + '/download_url', urllib.parse.urlencode({'csrf_token': tok(h)}).encode()))['url']
h = get(d).decode()
t = tok(h)
for i, n in re.findall(r'data-upload_id="(\d+)".*?title="([^"]+)"', h, re.S):
    print('upload', i, n)
    if rx and re.search(rx, n):
        u = json.loads(get(page + '/file/' + i + '?source=view_game', urllib.parse.urlencode({'csrf_token': t}).encode()))['url']
        open(os.path.join(out, n), 'wb').write(get(u))
        print('saved', n)
