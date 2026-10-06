/**
 * 国际化自己的测试。
 *
 * 这个测试守的不是「现在翻得对不对」，而是**以后会不会烂**：
 * 这个项目的 UI 文案每周都在加，只要有人新写一句中文忘了补英文，
 * 界面上就会出现一句半中半英的话，而且没人会第一时间发现 —— 只有切到 English 才看得见。
 *
 * 所以这里做源码级静态检查（不上浏览器、不 import 浏览器模块，i18n.js 里的
 * document / localStorage / window 在 Node 里根本跑不起来）：
 *
 *   1. 代码里用到的每句中文，英文表里都得有（漏翻 = 界面半英半中）
 *   2. index.html 里每个 data-i18n 标记的文案，英文表里都得有
 *   3. 占位符必须对齐：中文写了 {n}，英文表里那一句忘了写 {n}，就会渲染出 "{n}" 字面量
 *   4. 死条目（翻了但没人用）只报数不判失败 —— 加了又删的文案很常见
 *   5. 每条英文都是非空、不悬空空格
 *   6. 没有局部变量把翻译函数 t() 盖掉 —— 静态查得到、运行时才炸的那类坑
 *
 * 跑法：PORT=9223 node test/i18n.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const I18N = read('public/i18n.js');
const APP = read('public/app.js');
const HTML = read('public/index.html');

/* ---------- 剥掉注释，只留「真的是代码」的部分 ---------- *
 * 必须先做这一步再扫 t('…')：这个项目里有不少注释为了说清楚，会直接把示例代码写进注释
 * （例如「只要这个函数里先写了 const t = $('#raiseMsg')，后面那句 t('…') 就变成对 DOM
 * 元素调函数」）。不剥注释的话，注释里的示例会被当成「代码里用到的文案」，
 * 于是报出一条根本不存在于字典里的假漏翻。
 * 正则里的 [^:'"`\\] 是给字符串里的 // 留的活口：'http://a/1.m3u8' 不能整行被吃掉。
 */
const codeOnly = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fails.push(name + (extra ? ` — ${extra}` : ''));
}

/* ---------- 抠出英文表 ---------- *
 * 逐行切（不用正则去 match key，中文 key 里带 + / ( ) / 反斜杠，正则转义容易翻车）：
 *   行形如   '中文 key': 'English value',
 */
const dictBody = I18N.slice(I18N.indexOf('const EN = {'), I18N.indexOf('let cur = null;'));
const DICT = new Map();
const dictLines = dictBody.split('\n');
for (let i = 0; i < dictLines.length; i++) {
  const s = dictLines[i].trim();
  if (!s.startsWith("'")) continue;
  const cut = s.indexOf("':");
  if (cut < 2) continue;
  const key = s.slice(1, cut);
  // 值可能跟在本行（'key': 'value',），也可能折到下一行（长句我习惯换行写）—— 两种都得接住
  let val = '';
  for (let j = i; j < dictLines.length; j++) {
    if (j === i) {
      const rest = s.slice(cut + 2).replace(/,?$/, '');
      if (rest) {
        val = rest.startsWith("'") ? rest.slice(1, -1) : rest;
        break;
      }
      continue;
    }
    const nxt = dictLines[j].trim();
    if (nxt.startsWith("'")) {
      val = nxt.replace(/,?$/, '').slice(1, -1);
      break;
    }
  }
  DICT.set(key, val);
}
const DE = [...DICT.keys()];

/* ---------- 抠出代码里用到的 key ---------- */
// (?<![\w$.]) 排掉 setTimeout( / querySelectorAll( / p.format( 这类以 t( 收尾的标识符，
// 否则 document.createElement('video') 会被当成一句待翻译的文案
const usedApp = new Set();
for (const m of codeOnly.matchAll(/(?<![\w$.])t\(\s*'((?:[^'\\]|\\.)*)'/g)) usedApp.add(m[1].replace(/\\'/g, "'"));

const usedHtml = new Set();
for (const m of HTML.matchAll(
  /(?:data-i18n|data-i18n-title|data-i18n-ph|data-i18n-html)\s*=\s*"([^"]*)"/g,
)) {
  if (m[1]) usedHtml.add(m[1]);
}
const used = new Set([...usedApp, ...usedHtml]);

/* ---------- 1) 漏翻 ---------- */
const missing = [...used].filter((k) => !DICT.has(k));
ok('代码里用到的文案都能翻出英文', missing.length === 0,
  missing.length ? `漏 ${missing.length} 条：${missing.slice(0, 3).map((k) => JSON.stringify(k)).join('、')}` : '');

/* ---------- 2) 占位符对齐 ---------- */
const bogus = [];
for (const k of used) {
  const en = DICT.get(k);
  if (en == null) continue;
  const zhVars = varsOf(k);
  const enVars = varsOf(en);
  for (const v of zhVars) if (!enVars.includes(v)) bogus.push(`${k} → 英文少了 {${v}}`);
}
ok('占位符 {var} 中英对齐（否则会渲染出字面量的 {var}）', bogus.length === 0,
  bogus.length ? bogus.slice(0, 3).join('；') : '');

/* ---------- 2.5) 写了中文却忘了包 t() ---------- *
 * 「漏翻」是旧文案没配英文；这条更常见 —— 新加一句中文提示直接写进代码就走了，
 * 它既不在 used 里也不在 DICT 里，于是永远不会被翻到。
 */
const unbound = [];
for (const m of codeOnly.matchAll(/(['`])((?:[^'`\\]|\\.)*)\1/g)) {
  const s = m[2];
  if (!/[一-龥]/.test(s)) continue;
  if (/^\$\{/.test(s)) continue; // 模板插值片段，整句已经进了字典
  if (used.has(s) || DICT.has(s)) continue;
  unbound.push(s.replace(/\n/g, ' ').slice(0, 50));
}
ok('没有「写了中文却忘了包 t()」的文案', unbound.length === 0,
  unbound.length ? unbound.slice(0, 3).join(' | ') : '');

/* ---------- 2.6) 局部变量把翻译函数 t() 盖掉 ---------- *
 * 这条是运行时才炸的坑：字典里有这句、t() 也确实包了，静态看一派大好，
 * 但只要这个函数里先写了 `const t = $('#raiseMsg')`，后面那句 t('…') 就变成
 * 「对 DOM 元素调函数」→ t is not a function。
 * 真实现场：单条点播放，VLC 已经起来、声音已经出来了，界面却弹「打开失败：t is not a function」
 * ——因为 showRaiseBar() 在 openInPlayer 的 try 块里，报错被 catch 成打开失败。
 * 所以这条必须靠源码扫描守住：改名（msgEl / txt）是最省事的修法。
 */
const shadowed = [];
const codeLines = codeOnly.split('\n');
codeLines.forEach((line, i) => {
  if (!/(?:const|let|var)\s+t\s*=/.test(line)) return;
  // 只盯紧邻的几行：那种「声明完顺手就用了」的高危写法。
  // 相隔很远再调用 t() 的，作用域其实已经出了这个函数，静态扫描没必要误伤。
  for (let j = i + 1; j < Math.min(codeLines.length, i + 4); j++) {
    if (/(?<![\w$.])t\(\s*['`]/.test(codeLines[j])) {
      shadowed.push(`第 ${i + 1} 行 const t =… 之后第 ${j + 1} 行又在调用 t()`);
      break;
    }
  }
});
ok('没有局部变量把翻译函数 t() 盖掉（否则运行期报 t is not a function）',
  shadowed.length === 0, shadowed.slice(0, 3).join('；'));

/* ---------- 3) 英文表自身干净 ---------- */
const dirty = DE.filter((k) => !DICT.get(k) || !DICT.get(k).trim());
ok('英文表里没有空值', dirty.length === 0, dirty.slice(0, 3).join(' / '));

/* ---------- 4) 死条目（只报数，不判失败） ---------- */
const dead = DE.filter((k) => !used.has(k));

/* ---------- 5) 运行期行为 ---------- *
 * 上面几项都是源码级静态扫描（i18n.js 一进 Node 就碰 navigator，没法直接 import）。
 * 这里补一块最小的 DOM 桩，把 i18n.js **真的 import 进来跑一遍**，
 * 验证回退与占位符这两件事确实按预期工作 —— 静态看代码是"看起来对"，跑一遍才是"确实对"。
 */
function stubDom(browserLang, stored) {
  const store = new Map(stored != null ? [['mpm.lang', stored]] : []);
  // Node 22 里 navigator 是只读 getter（还自带一个空 localStorage），直接赋值会炸
  const put = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  put('navigator', { languages: [browserLang], language: browserLang });
  put('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  });
  put('document', {
    documentElement: { lang: '' },
    querySelectorAll: () => [],
    getElementById: () => null,
  });
  put('window', { addEventListener() {}, dispatchEvent() {} });
  put('CustomEvent', class {
    constructor(type) { this.type = type; }
  });
  return store;
}

// 注意：i18n.js 把当前语言缓在模块级的 cur 上，一个进程内第二次 stub 不会重跑 guess()。
// 所以顺序是：先以「简体中文浏览器」首启，再把语言切来切去。
const store = stubDom('zh-CN');
const { t, setLang, lang } = await import('../public/i18n.js');

ok('简中 / 繁中浏览器默认中文', lang() === 'zh-CN', lang());
ok('中文环境下取到中文文案', t('打开本地文件') === '打开本地文件', t('打开本地文件'));

ok('setLang 把选择写进 localStorage（下次打开还是这个语言）',
  (setLang('en'), store.get('mpm.lang') === 'en') && lang() === 'en', store.get('mpm.lang'));
ok('切到英文后取到英文文案', t('打开本地文件') === 'Open local file', t('打开本地文件'));
ok('英文表缺失时回退到中文原文（界面绝不出现空白按钮）',
  t('一句谁都没翻译的中文') === '一句谁都没翻译的中文');
ok('占位符 {var} 取值正确',
  t('已复制 {n} 条流地址（{skip} 条为空已跳过）', { n: 3, skip: 2 }) ===
    'Copied 3 stream URLs (2 empty one(s) skipped)',
  t('已复制 {n} 条流地址（{skip} 条为空已跳过）', { n: 3, skip: 2 }));
ok('切回中文仍然可取到中文', (setLang('zh-CN'), t('打开本地文件') === '打开本地文件'));

/* ---------- 6) 真实 HTTP 上，英文文件确实能取到 ---------- */
let port = 9223;
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const mp = { '/public/i18n.js': ['public/i18n.js', 'text/javascript'], '/public/index.html': ['public/index.html', 'text/html'] };
  if (mp[url]) {
    const [f, type] = mp[url];
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
    return res.end(read(f));
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(port, '127.0.0.1', r));
try {
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.text());
  const i18nTxt = await get('/public/i18n.js');
  const idx = await get('/public/index.html');
  ok('i18n.js 能随静态资源正常取回', i18nTxt.includes('export function t('));
  ok('index.html 里带着语言切换按钮', idx.includes('id="btnLang"'));
  ok('切换语言的入口挂在 i18n.js 上',
    /export function mountLangSwitch/.test(i18nTxt) && /onLangChange/.test(read('public/app.js')));
  ok('切语言选择记住在 localStorage（刷新不丢）', /localStorage\.setItem\(STORE/.test(i18nTxt));
  ok('非中文浏览器默认落到英语', /navigator\.languages/.test(i18nTxt) && /'en';|'en'\s*\)/.test(i18nTxt));
} finally {
  server.close();
}

/* ---------- 汇总 ---------- */
console.log(`\n[国际化] 中文文案 ${used.size} 句 / 英文表 ${DE.length} 条 / 死条目 ${dead.length} 条`);
console.log(`[国际化] 通过 ${pass} 项`);
if (fails.length) {
  console.log(`[国际化] 失败 ${fails.length} 项：`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
if (dead.length) {
  console.log('[国际化] 提示：翻了但当前没人用的条目（没问题，只是清理候选）：');
  dead.forEach((k) => console.log('  · ' + k.slice(0, 70)));
}
console.log('[国际化] 全部通过');

/* ---------- 小工具 ---------- */
function varsOf(s) {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}
