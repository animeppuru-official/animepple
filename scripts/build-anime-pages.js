// 作品ページ(/anime/<id>/)と作品一覧(/titles/)の静的ページ生成スクリプト。
//
// [背景] アニメップルはGitHub Pages上のSPAで、/anime/…のURLは実ファイルが無くHTTP 404で返るため、
// Googleから見ると作品ページが1枚も存在しなかった(AdSense審査「有用性の低いコンテンツ」却下の
// 原因の一つ、およびアニメ名検索からの流入が取れない原因)。Supabaseのanime_pages(約8,500作品)から、
// クローラーにも本文が見える実ファイル(HTTP 200)を自動生成する。
//
// 使い方(依存パッケージなし。Node 18以上):
//   node scripts/build-anime-pages.js [--out <出力先ディレクトリ>] [--limit <件数>]
//   --out 省略時: カレントに index.html があればそこ(=GitHubリポジトリのルート、Actions用)、
//                 無ければ ../app (ローカル)。ローカルで試す時は app/ を汚さないよう--outで別の場所を指定すること。
// 出力: <out>/anime/<公開ID>/index.html(作品ごと) <out>/titles/index.html と <out>/titles/<n>/index.html(一覧)
//       <out>/sitemap-anime.xml
// 本番ではGitHub Actions(.github/workflows/build-anime-pages.yml)が週1回と手動実行で再生成し、
// 差分をmainへコミットする(Pagesはmainブランチから配信)。ページ内に日時などの変動要素は入れない
// (入れると毎回全ファイルが差分になり、リポジトリが肥大化するため)。
const fs = require('fs');
const path = require('path');

const ORIGIN = 'https://animepple.com';
const PAGE_SIZE = 200; // 作品一覧1ページあたりの件数

// ── 純粋関数(テストから直接呼ぶ) ──
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// index.html側のpublicAnimeId()と同じ規則(wiki-xxx → a-xxx)
function publicId(id) { return id.startsWith('wiki-') ? 'a-' + id.slice(5) : id; }
function typeLabel(meta) { return meta === 'movie' ? '映画' : 'TVアニメ'; }
function clip(s, n) { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

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

const CSS = `
:root{--bg:#0a1c12;--card:#10301f;--line:#2a3830;--text:#dfeae3;--muted:#8db5a0;--brand:#5ec97a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Hiragino Sans","Yu Gothic",sans-serif;line-height:1.85;font-size:15px}
a{color:var(--brand)}
header.site{border-bottom:1px solid var(--line);padding:14px 20px;display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center}
header.site .logo{font-weight:900;font-size:20px;color:var(--brand);text-decoration:none}
header.site nav a{color:var(--muted);text-decoration:none;font-size:13px;margin-right:14px}
main{max-width:760px;margin:0 auto;padding:28px 20px 56px}
h1{font-size:1.5rem;color:#eaf6ee;margin:0 0 .3rem}
h2{font-size:1.1rem;color:#eaf6ee;margin:2rem 0 .6rem}
p,li,dd{color:#c3d4c9}
.sub{color:var(--muted);margin:0 0 1.2rem;font-size:14px}
dl.facts{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:1rem 0;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.02)}
dl.facts dt{color:var(--muted);font-size:13px}
dl.facts dd{margin:0}
a.cta{display:inline-block;margin:1.2rem 0;padding:11px 20px;border-radius:10px;background:var(--brand);color:#07200f;font-weight:800;text-decoration:none}
ul.rel{padding-left:1.2rem;margin:.4rem 0}
ul.rel li{margin:.15rem 0}
.lang-section{border-top:1px solid var(--line);margin-top:2.5rem;padding-top:1.2rem}
.pager{display:flex;flex-wrap:wrap;gap:6px;margin:1.4rem 0;font-size:13px}
.pager a,.pager span{padding:3px 9px;border:1px solid var(--line);border-radius:8px;text-decoration:none}
.pager span{background:var(--brand);color:#07200f;font-weight:800}
ul.titles{list-style:none;padding:0;columns:1}
ul.titles li{border-bottom:1px solid rgba(255,255,255,.05);padding:3px 0}
@media(min-width:700px){ul.titles{columns:2;column-gap:28px}}
footer.site{border-top:1px solid var(--line);padding:22px 20px;text-align:center;font-size:12.5px;color:var(--muted)}
footer.site a{color:var(--muted);margin:0 8px}
`.trim();

const NAV = [['/', 'ホーム'], ['/titles/', '作品一覧'], ['/about/', 'アニメップルについて'], ['/terms/', '利用規約'], ['/privacy-policy/', 'プライバシーポリシー'], ['/contact', 'お問い合わせ']];

function shell({ title, description, canonicalPath, body, jsonLd, noindex }) {
  const nav = NAV.map(([h, l]) => `<a href="${h}">${l}</a>`).join('');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${ORIGIN}${canonicalPath}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${ORIGIN}${canonicalPath}">
<meta property="og:type" content="website">
<meta name="robots" content="${noindex ? 'noindex,follow' : 'index,follow'}">
<style>${CSS}</style>${jsonLd ? `\n<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>
<header class="site"><a class="logo" href="/">アニメップル</a><nav>${nav}</nav></header>
<main>
${body}
</main>
<footer class="site">© アニメップル · <a href="/">ホームへ戻る</a> · <a href="/titles/">作品一覧</a></footer>
</body>
</html>
`;
}

function renderAnimePage(r, rel) {
  const pid = publicId(r.id);
  const type = typeLabel(r.meta);
  const heading = esc(r.title);
  const facts = [
    ['種別', type],
    r.year ? ['公開・放送年', `${esc(r.year)}年`] : null,
    r.episodes ? ['話数', `${esc(r.episodes)}話`] : null,
    r.studios && r.studios.length ? ['制作', esc(r.studios.join('、'))] : null,
    r.genres && r.genres.length ? ['ジャンル', esc(r.genres.join('、'))] : null,
  ].filter(Boolean);
  const list = (items) => items.length ? `<ul class="rel">${items.map(x => `<li><a href="/anime/${publicId(x.id)}/">${esc(x.title)}</a>${x.year ? `（${esc(x.year)}年）` : ''}</li>`).join('')}</ul>` : '';
  const studioName = r.studios && r.studios[0];
  const body = `<h1>${heading}</h1>
${r.title_en ? `<p class="sub">${esc(clip(r.title_en, 120))}</p>` : ''}
<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
<h2>あらすじ</h2>
<p>${esc(r.description)}</p>
<p><a class="cta" href="/anime/${pid}/open">アニメップルでみんなの評価グラフを見る・レビューを書く →</a></p>
${rel.sameStudio.length ? `<h2>${esc(studioName)}の他の作品</h2>${list(rel.sameStudio)}` : ''}
${rel.sameYear.length ? `<h2>${esc(r.year)}年の${esc(type)}</h2>${list(rel.sameYear)}` : ''}
${r.description_en ? `<section class="lang-section" lang="en" id="en"><h2>Synopsis</h2><p>${esc(r.description_en)}</p></section>` : ''}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': r.meta === 'movie' ? 'Movie' : 'TVSeries',
    name: r.title,
    ...(r.title_en ? { alternateName: r.title_en } : {}),
    description: r.description,
    ...(r.year ? { datePublished: String(r.year) } : {}),
    ...(r.meta !== 'movie' && r.episodes ? { numberOfEpisodes: Number(r.episodes) || undefined } : {}),
    ...(studioName ? { productionCompany: { '@type': 'Organization', name: studioName } } : {}),
    url: `${ORIGIN}/anime/${pid}/`,
  };
  const yearPart = r.year ? `${r.year}年・` : '';
  return shell({
    title: `${r.title}（${yearPart}${type}）のあらすじ・作品情報 | アニメップル`,
    description: `${r.title}（${yearPart}${type}）のあらすじと作品情報。${clip(r.description, 70)} 12軸のみんなの評価グラフはアニメップルで。`,
    canonicalPath: `/anime/${pid}/`,
    body, jsonLd,
  });
}

function pagePath(n) { return n === 1 ? '/titles/' : `/titles/${n}/`; }
function renderHubPage(rows, n, total) {
  const start = (n - 1) * PAGE_SIZE;
  const slice = rows.slice(start, start + PAGE_SIZE);
  const pager = Array.from({ length: total }, (_, i) => i + 1).map(i => i === n ? `<span>${i}</span>` : `<a href="${pagePath(i)}">${i}</a>`).join('');
  const body = `<h1>アニメ作品一覧</h1>
<p class="sub">アニメップルに登録されている作品の一覧です（${rows.length.toLocaleString('en-US')}作品・${n}/${total}ページ）。作品名を選ぶと、あらすじ・作品情報と、みんなの評価グラフへのリンクが開きます。</p>
<div class="pager">${pager}</div>
<ul class="titles">${slice.map(r => `<li><a href="/anime/${publicId(r.id)}/">${esc(r.title)}</a>${r.year ? `（${esc(r.year)}年）` : ''}</li>`).join('')}</ul>
<div class="pager">${pager}</div>`;
  return shell({
    title: `アニメ作品一覧（${n}/${total}ページ） | アニメップル`,
    description: `アニメップルに登録されているアニメ作品の一覧（${n}/${total}ページ）。作品ごとのあらすじ・作品情報と、みんなの評価グラフへのリンクを掲載しています。`,
    canonicalPath: pagePath(n),
    body,
  });
}

function renderSitemap(rows, hubCount) {
  const urls = [...Array.from({ length: hubCount }, (_, i) => pagePath(i + 1)), ...rows.map(r => `/anime/${publicId(r.id)}/`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${ORIGIN}${u}</loc></url>`).join('\n')}
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
  // 一覧の並び: 新しい年が先、同年は作品名順(決定的)
  rows.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  if (Number.isFinite(limit)) rows = rows.slice(0, limit);
  console.log(`取得 ${fetched.length}件 → 公開対象 ${rows.length}件`);

  const relFor = buildRelations(rows);
  for (const r of rows) {
    const dir = path.join(outDir, 'anime', publicId(r.id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), renderAnimePage(r, relFor(r)), 'utf8');
  }
  const hubCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  for (let n = 1; n <= hubCount; n++) {
    const dir = n === 1 ? path.join(outDir, 'titles') : path.join(outDir, 'titles', String(n));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), renderHubPage(rows, n, hubCount), 'utf8');
  }
  fs.writeFileSync(path.join(outDir, 'sitemap-anime.xml'), renderSitemap(rows, hubCount), 'utf8');
  console.log(`生成: ${rows.length}作品ページ + 一覧${hubCount}ページ + sitemap-anime.xml → ${outDir}`);
}

module.exports = { esc, publicId, typeLabel, clip, selectRows, buildRelations, renderAnimePage, renderHubPage, renderSitemap, PAGE_SIZE };

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
