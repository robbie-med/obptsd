#!/usr/bin/env bash
# Build dist/ld-night.html: the whole game in one file (CSS + bundled JS inlined), openable from disk / a phone.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
npx -y esbuild@0.24.0 js/ui/app.js --bundle --format=iife --minify --log-level=warning --outfile=dist/.bundle.js
python3 - <<'EOF'
import re
html = open('index.html').read()
css = open('css/style.css').read()
js = open('dist/.bundle.js').read().replace('</script', '<\\/script')
html = html.replace('<link rel="stylesheet" href="css/style.css">', '<style>\n' + css + '\n</style>')
html = re.sub(r'<script type="module" src="js/ui/app.js"></script>', lambda m: '<script>\n' + js + '\n</script>', html)
open('dist/ld-night.html', 'w').write(html)
EOF
rm dist/.bundle.js
ls -la dist/ld-night.html
