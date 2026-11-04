// ひとり練習版を1ファイルのHTMLにまとめる（サーバー不要）
const fs = require('fs');
const path = require('path');
const pub = path.join(__dirname, '..', 'public');
let html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
const core = fs.readFileSync(path.join(pub, 'core.js'), 'utf8');
const client = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');
html = html.replace('<link rel="stylesheet" href="style.css">', () => `<style>\n${css}\n</style>`);
html = html.replace('<script src="core.js"></script>', '<script>window.BLOB_SOLO_ONLY = true;</script>\n<script src="core.js"></script>');
html = html.replace('<script src="core.js"></script>', () => `<script>\n${core}\n</script>`);
html = html.replace('<script src="client.js"></script>', () => `<script>\n${client}\n</script>`);
const out = path.join(__dirname, '..', 'dist', 'blob-arena-solo.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('wrote', out, html.length, 'bytes');

// 公開ページ用（doctype・html・head・bodyタグを外した本文だけの版）
const body = html
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<\/?html[^>]*>\s*/gi, '')
  .replace(/<\/?head>\s*/gi, '')
  .replace(/<\/?body>\s*/gi, '')
  .replace(/<meta charset="utf-8">\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '');
fs.writeFileSync(path.join(path.dirname(out), 'artifact.html'), body);
