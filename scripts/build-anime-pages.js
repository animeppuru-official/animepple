// 【廃止】作品ページの検索エンジン向けファイル生成は、Cloudflare Worker(cloudflare-worker/security-headers.worker.mjs)
// に置き換えた(2026-10-05)。Workerが、作品・記事ページを開かれた時にその場で、title/description/canonical/
// 構造化データ/あらすじをindex.htmlに差し込んで200で返し、存在しない作品は404で返す。sitemap-anime.xmlもWorkerが作る。
// 以前はこのスクリプトが作品ごとに小さなファイルを約15,000個(anime/)と一覧(titles/)を書き出していたが、
// 「一般的なやり方ではない」ため廃止した。
//
// このスクリプトは今は、以前の生成物(anime/・titles/・sitemap-anime.xml)をリポジトリから消すだけ。
// GitHub Actionsのワークフロー(Build anime pages)が、これを実行して削除をコミットする。
// 削除が済んだら、ワークフロー(.github/workflows/build-anime-pages.yml)とこのファイルは削除してよい。
const fs = require('fs');
const path = require('path');

const root = process.cwd();
for (const p of ['anime', 'titles', 'sitemap-anime.xml']) {
  fs.rmSync(path.join(root, p), { recursive: true, force: true });
}
console.log('以前の生成物(anime/・titles/・sitemap-anime.xml)を削除しました。作品ページはCloudflare Workerが配信します。');
