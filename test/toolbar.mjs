/**
 * 工具栏那个 ▶ 按钮的文案 —— 只有真的选中了才带条数，没选中就退回「▶ 用播放器打开」。
 *
 * 起因（真机报的 bug）：选中 3 条 → 按钮显示「▶ 排进一个窗口 (3)」→ 把这 3 条删掉
 * （走的是 render()，不是 syncSelectionUI），选区已经空了，按钮还挂着 3。
 * 顺带发现反向的坑：没选中时按旧写法 pickTargets() 等于整表，一重算就变成
 * 「(整表条数)」，看着像点下去要排几百条。
 *
 * 抠源码 + DOM 桩跑，不重抄一份实现。
 */
import { readFileSync } from 'node:fs';

let pass = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? ' → ' + extra : ''}`);
  }
};

const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const SRC = APP.match(/function syncPlayBtn\(\) \{[\s\S]*?\n\}/);
ok('源码里能抠出 syncPlayBtn', !!SRC);
const syncPlayBtnSrc = SRC[0];

/* ---------------- 桩 ---------------- */

const ident = (s, o = {}) => String(s).replace(/\{(\w+)\}/g, (_, k) => String((o[k] ?? '')));

const mkState = (entries, selected) => ({
  entries,
  selected: selected || new Set(),
});

const withBtn = (syncPlayBtn, $) => syncPlayBtn($);

function build({ entries, selected, safari = false }) {
  const btn = { textContent: '', title: '' };
  const state = mkState(entries, selected);
  const $ = (sel) => (sel === '#btnPlaySel' ? btn : null);
  const syncPlayBtn = new Function(
    '$',
    'state',
    't',
    'BROWSER_HLS',
    `${syncPlayBtnSrc}\nreturn syncPlayBtn;`,
  )($, state, ident, safari);
  withBtn(syncPlayBtn, $);
  return { btn, state, syncPlayBtn, $ };
}

const entry = (id, url) => ({ id, title: id, url, attrMap: {} });
const http = (id) => entry(id, `http://x/${id}.m3u8`);

/* ---------------- 1. 没选中：退回基础文案，别挂整表条数 ---------------- */

const probe = (entries, selected, opts) => {
  const h = build({ entries, selected, ...(opts || {}) });
  return h.btn;
};

let btn = probe([http('a'), http('b'), http('c')], new Set());
ok('没选中任何频道 → 只显示「▶ 用播放器打开」（不带整表条数）', btn.textContent === '▶ 用播放器打开', btn.textContent);
ok('没选中时的 tooltip 说清了「没选就按整表 N 条」', /整表 3 条/.test(btn.title), btn.title);

btn = probe([], new Set());
ok('空列表也没选中 → 基础文案', btn.textContent === '▶ 用播放器打开');
ok('空列表的 tooltip 不会显示 -1 / 空占位', !/\(-?\d+\)/.test(btn.title), btn.title);

/* ---------------- 2. 选中：按「能播的 http 条数」算，不是选中数 ---------------- */

btn = probe([http('a'), http('b'), http('c')], new Set(['a', 'b', 'c']));
ok('选 3 条 → 「▶ 排进一个窗口 (3)」', btn.textContent === '▶ 排进一个窗口 (3)', btn.textContent);
ok('选 3 条时的 tooltip 讲的是排同一个窗口', /排进同一个播放器窗口/.test(btn.title), btn.title);

btn = probe([http('a'), http('b'), entry('c', 'file:///c.m3u8')], new Set(['a', 'b', 'c']));
ok('选了 3 条但只有 2 条是 http → 显示 (2)（file:// 排不进播放器）', btn.textContent === '▶ 排进一个窗口 (2)', btn.textContent);

btn = probe([http('a'), entry('b', ''), entry('c', 'file:///c.m3u8')], new Set(['b']));
ok('只勾中 1 条（且没 http 地址）→ 退回基础文案', btn.textContent === '▶ 用播放器打开', btn.textContent);
ok('单选时的 tooltip 指向「打开所选频道」', /打开所选频道/.test(btn.title), btn.title);

/* ---------------- 3. Safari / 浏览器内播：一次只开一条，不排队 ---------------- */

btn = probe([http('a'), http('b')], new Set(['a', 'b']), { safari: true });
ok('浏览器自己能播 HLS 时（Safari/iOS）→ 不写「排进一个窗口」', btn.textContent === '▶ 用播放器打开', btn.textContent);

/* ---------------- 4. 删完频道必须清零（这次报的 bug） ---------------- */

const h = build({ entries: [http('a'), http('b'), http('c')], selected: new Set(['a', 'b', 'c']) });
ok('删除前：3 条选中 → 按钮挂 (3)', h.btn.textContent === '▶ 排进一个窗口 (3)', h.btn.textContent);

// 复刻 #btnDelSel 的删除路径：清 entries → 清选区 → render()
h.state.entries = h.state.entries.filter((e) => !h.state.selected.has(e.id));
h.state.selected.clear();
h.syncPlayBtn(h.$);
ok('删掉这 3 条之后 → 按钮回到「▶ 用播放器打开」（数字清零）', h.btn.textContent === '▶ 用播放器打开', h.btn.textContent);
ok('清零后 tooltip 不再提「这 3 条」', !/这 \d+ 条/.test(h.btn.title), h.btn.title);

// 删到只剩一条可播：按钮数字要跟着小
const h2 = build({ entries: [http('a'), http('b'), http('c')], selected: new Set(['a', 'b', 'c']) });
h2.state.entries = [http('c')];
h2.state.selected = new Set(['c']);
h2.syncPlayBtn(h2.$);
ok('删到只剩 1 条可选 → 退回「▶ 用播放器打开」', h2.btn.textContent === '▶ 用播放器打开', h2.btn.textContent);

// 删掉之后又勾新的：数字要换成新的
const h3 = build({ entries: [http('a'), http('b'), http('c')], selected: new Set(['a', 'b']) });
h2.state.entries = [http('a'), http('b'), http('c')];
h2.syncPlayBtn(h2.$);
ok('重新勾 1 条 → 显示 (1) 的条件成立（n>1 才带数字，1 条仍是基础文案）', h2.btn.textContent === '▶ 用播放器打开', h2.btn.textContent);

/* ---------------- 5. 三个刷新入口都得调它（防这条 bug 再回来） ---------------- */

const renderSrc = APP.match(/function render\(\) \{[\s\S]*?\n\}/)[0];
const syncSelSrc = APP.match(/function syncSelectionUI\(\) \{[\s\S]*?\n\}/)[0];

ok('render() 里会重算按钮（删除频道走的就是 render）', /syncPlayBtn\(\)/.test(renderSrc));
ok('syncSelectionUI() 里会重算按钮（勾选 / 取消选区）', /syncPlayBtn\(\)/.test(syncSelSrc));
ok(
  '行内复选框的 change 分支也会重算（那条路不重建表格，光改 stat 不够）',
  /cb\.checked \? state\.selected\.add\(id\)[\s\S]{0,160}syncPlayBtn\(\)/.test(APP),
);

/* ---------------- 6. DOM 缺失时不能炸 ---------------- */

const noBtn = new Function('$', 'state', 't', 'BROWSER_HLS', `${syncPlayBtnSrc}\nreturn syncPlayBtn;`)(() => null, mkState([http('a')]), ident, false);
let threw = null;
try {
  noBtn();
} catch (e) {
  threw = e;
}
ok('页面上没有 #btnPlaySel（按钮被隐藏时）不报错', threw === null, threw && threw.message);

console.log(`\n[工具栏▶文案] 通过 ${pass} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
