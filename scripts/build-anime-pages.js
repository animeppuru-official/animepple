// 作品ページ(/anime/<id>/<タイトル>)を「検索エンジンにも見える」ようにするためのファイル生成スクリプト。
//
// [背景] アニメップルはGitHub Pages上のSPAで、/anime/…のURLは実ファイルが無くHTTP 404で返るため、
// Googleから見ると作品ページが1枚も存在しなかった(アニメ名検索から入れない原因、AdSense「有用性の低い
// コンテンツ」却下の一因)。アプリの作品ページ自体は変えず、**同じURL**に小さなファイル(ローダー)を置く:
//   - 検索エンジン: HTTP 200で、作品名・あらすじ・作品情報などの文章がそのまま見える
//   - 人: 読み込み直後に、いつものアプリ(index.html)がそのURLのまま立ち上がり、今までと同じ作品ページが出る
// 新しい見た目の「簡易ページ」は人には見せない(人が見るのはアプリの作品ページだけ)。
//
// 使い方(依存パッケージなし。Node 18以上):
//   node scripts/build-anime-pages.js [--out <出力先ディレクトリ>] [--limit <件数>]
//   --out 省略時: カレントに index.html があればそこ(=GitHubリポジトリのルート、Actions用)、
//                 無ければ ../app (ローカル)。ローカルで試す時は app/ を汚さないよう--outで別の場所を指定すること。
// 出力: <out>/anime/<公開ID>/index.html と <out>/anime/<公開ID>/<スラッグ>/index.html(スラッグはアプリのURLと同じ規則)
//       <out>/sitemap-anime.xml
// 本番ではGitHub Actions(.github/workflows/build-anime-pages.yml)が週1回と手動実行で再生成し、
// 差分をmainへコミットする。ページ内に日時などの変動要素は入れない(毎回全ファイルが差分になるのを防ぐ)。
const fs = require('fs');
const path = require('path');

const ORIGIN = 'https://animepple.com';

// ── 純粋関数(テストから直接呼ぶ) ──
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// index.html側のpublicAnimeId()と同じ規則(wiki-xxx → a-xxx)
function publicId(id) { return id.startsWith('wiki-') ? 'a-' + id.slice(5) : id; }
function typeLabel(meta) { return meta === 'movie' ? '映画' : 'TVアニメ'; }
function clip(s, n) { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// index.html側のslugifyTitleForUrl()と同じ規則(アプリが作るURLと完全に一致させる必要がある)
function slugify(title) {
  const t = (title || '').trim().replace(/\s+/g, '-').replace(/[\/\\?#]/g, '');
  return encodeURIComponent(t).slice(0, 100);
}
// スラッグをフォルダ名にできるか。途中で切れた%エスケープ・ファイルシステムで使えない文字・末尾のドットや空白は不可
// (不可の作品は、スラッグ無しのファイルだけを作る。そのURLは従来どおり404.html経由でアプリが開く)
function slugDirName(slugEnc) {
  let d;
  try { d = decodeURIComponent(slugEnc); } catch (_) { return null; }
  if (!d || /[:*"<>|\\%]/.test(d) || /[. ]$/.test(d) || d === '.' || d === '..') return null;
  return d;
}
// 作品の正規URL(アプリが作るURLと同じ形。末尾スラッシュ付き=GitHub Pagesの実ファイル)
function canonicalPath(r) {
  const s = slugify(r.title);
  return slugDirName(s) ? `/anime/${publicId(r.id)}/${s}/` : `/anime/${publicId(r.id)}/`;
}

// 公開対象: テスト用データ・あらすじの無い作品は除く(あらすじが無いと本文が実質ゼロのページになるため)
function selectRows(rows) {
  return rows.filter(r => r && r.id && r.title && !/^test-/.test(r.id) && r.description && r.description.trim().length > 0);
}

// 各作品が張る内部リンクの対象を決める。同じ制作会社・同じ年の「前後の作品」を取ることで、
// 全作品がどこかから必ずリンクされ、特定の人気作品にリンクが偏らないようにする(決定的・日時に依存しない)
function buildRelations(rows) {
  const byKey = (keyFn) => {
    const m = new Map();
    rows.forEach(r => { const k = keyFn(r); if (k) { if (!m.has(k)) m.set(k, []); m.get(k).push(r); } });
    m.forEach(list => list.sort((a, b) => a.id < b.id ? -1 : 1));
    return m;
  };
  const studios = byKey(r => (r.studios && r.studios[0]) || null);
  const years = byKey(r => r.year ? `${r.year}|${r.meta}` : null);
  const neighbors = (map, key, self, count) => {
    const list = map.get(key) || [];
    const i = list.findIndex(x => x.id === self.id);
    if (i < 0 || list.length < 2) return [];
    const out = [], seen = new Set([self.id]);
    for (let step = 1; out.length < count && step < list.length; step++) {
      const cand = list[(i + step) % list.length];
      if (!seen.has(cand.id)) { seen.add(cand.id); out.push(cand); }
    }
    return out;
  };
  return (r) => ({
    sameStudio: neighbors(studios, (r.studios && r.studios[0]) || null, r, 6),
    sameYear: neighbors(years, r.year ? `${r.year}|${r.meta}` : null, r, 6),
  });
}

// ローダー: 人が開いたときは、いつものアプリ(/index.html)をこのURLのまま読み込んで差し替える。
// アプリのindex.htmlは絶対パス(/skins.css等)なので、そのまま書き込んで動く。
// 読み込みに失敗したら(オフライン等)、書いてある文章をそのまま残す。
const LOADER = `(function(){
  fetch('/index.html', { credentials: 'same-origin' })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
    .then(function (html) { document.open(); document.write(html); document.close(); })
    .catch(function () {});
})();`;

function renderAnimePage(r, rel) {
  const type = typeLabel(r.meta);
  const canon = canonicalPath(r);
  const facts = [
    ['種別', type],
    r.year ? ['公開・放送年', `${esc(r.year)}年`] : null,
    r.episodes ? ['話数', `${esc(r.episodes)}話`] : null,
    r.studios && r.studios.length ? ['制作', esc(r.studios.join('、'))] : null,
    r.genres && r.genres.length ? ['ジャンル', esc(r.genres.join('、'))] : null,
  ].filter(Boolean);
  const list = (items) => items.length ? `<ul>${items.map(x => `<li><a href="${canonicalPath(x)}">${esc(x.title)}</a>${x.year ? `（${esc(x.year)}年）` : ''}</li>`).join('')}</ul>` : '';
  const studioName = r.studios && r.studios[0];
  const body = `<h1>${esc(r.title)}</h1>
${r.title_en ? `<p>${esc(clip(r.title_en, 120))}</p>` : ''}
<dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
<h2>あらすじ</h2>
<p>${esc(r.description)}</p>
${rel.sameStudio.length ? `<h2>${esc(studioName)}の他の作品</h2>${list(rel.sameStudio)}` : ''}
${rel.sameYear.length ? `<h2>${esc(r.year)}年の${esc(type)}</h2>${list(rel.sameYear)}` : ''}
${r.description_en ? `<section lang="en" id="en"><h2>Synopsis</h2><p>${esc(r.description_en)}</p></section>` : ''}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': r.meta === 'movie' ? 'Movie' : 'TVSeries',
    name: r.title,
    ...(r.title_en ? { alternateName: r.title_en } : {}),
    description: r.description,
    ...(r.year ? { datePublished: String(r.year) } : {}),
    ...(r.meta !== 'movie' && r.episodes ? { numberOfEpisodes: Number(r.episodes) || undefined } : {}),
    ...(studioName ? { productionCompany: { '@type': 'Organization', name: studioName } } : {}),
    url: `${ORIGIN}${canon}`,
  };
  const yearPart = r.year ? `${r.year}年・` : '';
  const title = `${r.title}（${yearPart}${type}）のあらすじ・作品情報 | アニメップル`;
  const description = `${r.title}（${yearPart}${type}）のあらすじと作品情報。${clip(r.description, 70)} 12軸のみんなの評価グラフはアニメップルで。`;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${ORIGIN}${canon}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${ORIGIN}${canon}">
<meta property="og:type" content="website">
<meta name="robots" content="index,follow">
<style>html{background:#07150d;color:#e8f8ed;font-family:system-ui,sans-serif}body{max-width:760px;margin:0 auto;padding:24px 20px}a{color:#5ec97a}</style>
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
</head>
<body>
<main id="seo-static">
${body}
</main>
<script>${LOADER}</script>
</body>
</html>
`;
}

function renderSitemap(rows) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.map(r => `  <url><loc>${ORIGIN}${canonicalPath(r)}</loc></url>`).join('\n')}
</urlset>
`;
}

// ── 取得と書き出し ──
async function fetchAllAnime(supabaseUrl, anonKey) {
  const cols = 'id,title,title_en,meta,year,episodes,genres,studios,description,description_en';
  const out = [];
  for (let off = 0; ; off += 1000) {
    const res = await fetch(`${supabaseUrl}/rest/v1/anime_pages?select=${cols}&order=id&limit=1000&offset=${off}`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    if (!res.ok) throw new Error(`Supabase取得失敗: ${res.status} ${await res.text()}`);
    const page = await res.json();
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const cwdHasIndex = fs.existsSync(path.join(process.cwd(), 'index.html'));
  const siteRoot = cwdHasIndex ? process.cwd() : path.join(__dirname, '..', 'app');
  const outDir = path.resolve(arg('--out') || siteRoot);
  const limit = arg('--limit') ? Number(arg('--limit')) : Infinity;

  // 接続情報は、本番のindex.htmlに公開されているもの(anonキー=ブラウザに配信済みの公開値)を読む
  const indexHtml = fs.readFileSync(path.join(siteRoot, 'index.html'), 'utf8');
  const supabaseUrl = (indexHtml.match(/const SUPABASE_URL\s*=\s*'([^']+)'/) || [])[1];
  const anonKey = (indexHtml.match(/const SUPABASE_ANON\s*=\s*'([^']+)'/) || [])[1];
  if (!supabaseUrl || !anonKey) throw new Error('index.htmlからSUPABASE_URL/SUPABASE_ANONを読み取れない');

  const fetched = await fetchAllAnime(supabaseUrl, anonKey);
  let rows = selectRows(fetched);
  rows.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  if (Number.isFinite(limit)) rows = rows.slice(0, limit);
  console.log(`取得 ${fetched.length}件 → 公開対象 ${rows.length}件`);

  // 古い生成物(以前の簡易ページ・一覧ページ、削除された作品)を残さないよう、作り直す
  fs.rmSync(path.join(outDir, 'anime'), { recursive: true, force: true });
  fs.rmSync(path.join(outDir, 'titles'), { recursive: true, force: true });

  const relFor = buildRelations(rows);
  let withSlug = 0;
  for (const r of rows) {
    const html = renderAnimePage(r, relFor(r));
    const base = path.join(outDir, 'anime', publicId(r.id));
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'index.html'), html, 'utf8');
    const dirName = slugDirName(slugify(r.title));
    if (dirName) {
      fs.mkdirSync(path.join(base, dirName), { recursive: true });
      fs.writeFileSync(path.join(base, dirName, 'index.html'), html, 'utf8');
      withSlug++;
    }
  }
  fs.writeFileSync(path.join(outDir, 'sitemap-anime.xml'), renderSitemap(rows), 'utf8');
  console.log(`生成: ${rows.length}作品(うちスラッグ付きURL ${withSlug}件) + sitemap-anime.xml → ${outDir}`);
}

module.exports = { esc, publicId, typeLabel, clip, slugify, slugDirName, canonicalPath, selectRows, buildRelations, renderAnimePage, renderSitemap, LOADER };

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
