"""Package already-built app files; no source files or credentials are included."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
dist = root / 'dist'
assert (dist / 'MANGO-FX.html').is_file(), 'Run npm run build:standalone first'
assert (dist / 'service-worker.js').is_file(), 'Production PWA build is missing'

instructions = '''MANGO FX — Chromebook / Windows向け\n
【ファイルを開いて使う】\nMANGO-FX.htmlを「ダウンロード」フォルダなどに展開してChrome/Edgeで開きます。\n追加インストールや通信は不要です。\n
【ブラウザからアプリとしてインストール】\nPWA版のindex.html、assets、icons、manifest.webmanifest、favicon.svg、\nservice-worker.jsを同じHTTPSサイトに配置してください。\n公開URLをChrome/Edgeで開き、オフライン対応の表示を確認してから、\n画面上のインストールボタンまたはブラウザのインストールメニューを使います。\nHTMLをローカルで開いただけではPWAのインストールはできません。\n
取引データは利用した端末のブラウザ・公開URLごとに保存されます。\n別端末・別URLへの同期はありません。仮想資金と生成レートを使う練習用アプリです。\n'''
with ZipFile(dist / 'MANGO-FX.zip', 'w', ZIP_DEFLATED) as archive:
    archive.write(dist / 'MANGO-FX.html', 'MANGO-FX.html')
    archive.writestr('使い方.txt', instructions)

pwa_files = [dist / name for name in ['index.html', 'manifest.webmanifest', 'favicon.svg', 'service-worker.js']]
pwa_files += sorted((dist / 'assets').rglob('*')) + sorted((dist / 'icons').rglob('*'))
with ZipFile(dist / 'MANGO-FX-PWA.zip', 'w', ZIP_DEFLATED) as archive:
    for path in pwa_files:
        if path.is_file(): archive.write(path, path.relative_to(dist).as_posix())
    archive.writestr('使い方.txt', instructions)
for name in ['MANGO-FX.zip', 'MANGO-FX-PWA.zip']:
    with ZipFile(dist / name) as archive:
        assert archive.testzip() is None
    print(f'{name}: {(dist/name).stat().st_size:,} bytes')
