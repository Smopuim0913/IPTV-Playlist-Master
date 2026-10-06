/**
 * 界面顺序 / 提示条位置这两处小改动。
 *
 * 起因一：tvg-id 原本排在「分组」后面，也就是夹在「分组」和「流地址」之间。
 * 它其实是跟着频道名走的（一个频道叫什么 ↔ 对应哪个节目 ID），跟分组不是一伙的，
 * 于是把它的位置挪到「频道名和分组中间」。这个顺序在三个地方各写了一遍 ——
 * 表头 <th>、表格里那排行内输入框 <td>、编辑弹窗的字段数组 ——
 * 只改一处就会露馅（表头说一回事、行里是另一回事），所以三处一起钉。
 *
 * 起因二：「把播放器窗口调到最前」那条提示原先是顶在工具栏下面的一条横幅，
 * 属于文档流里实实在在的一行。开完流它从无到有冒出来，整页往下顶一截，
 * 人正要点的那一行跟着挪位 —— 这就是「点击位置视觉上错位」的来源。
 * 现在挪到视口底部当浮层：不占文档流，出都不动上面的东西。
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

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const HTML = read('index.html');
const APP = read('app.js');
const CSS = read('style.css');

/** 抠出某个函数源码（取到它那个缩进为 0 的收尾大括号为止） */
const grabFn = (head) => {
  const i = APP.indexOf(head);
  if (i < 0) return '';
  const j = APP.indexOf('\n}', i);
  return j < 0 ? APP.slice(i) : APP.slice(i, j + 2);
};

const ident = (s, o = {}) => String(s).replace(/\{(\w+)\}/g, (_, k) => String((o[k] ?? '')));

/* ============ 1. 表头：频道名 → tvg-id → 分组 ============ */

const thead = HTML.slice(HTML.indexOf('<thead>'), HTML.indexOf('</thead>'));
const ths = [...thead.matchAll(/<th class="(c-[a-z-]+)"/g)].map((m) => m[1]);
const at = (c) => ths.indexOf(c);
ok('表头抠得到三列', at('c-name') >= 0 && at('c-tvg') >= 0 && at('c-group') >= 0, ths.join('|'));
ok('表头：tvg-id 紧跟频道名', at('c-tvg') === at('c-name') + 1, ths.join('|'));
ok('表头：tvg-id 在分组之前', at('c-group') === at('c-tvg') + 1, ths.join('|'));

/* ============ 2. 行内那一排输入框：同一套顺序 ============ */

const rowSrc = grabFn('function rowHtml(e, i) {');
ok('源码里能抠出 rowHtml', !!rowSrc);
const rowFields = [...rowSrc.matchAll(/data-f="([a-z-]+)"/g)].map((m) => m[1]);
ok(
  '行内格：频道名 → tvg-id → 分组',
  rowFields[0] === 'title' && rowFields[1] === 'tvg-id' && rowFields[2] === 'group',
  rowFields.join('|'),
);

/* ============ 3. 编辑弹窗的字段：还是同一套顺序 ============ */

const modalSrc = grabFn('function openEntryModal(entry, opts = {}) {');
ok('源码里能抠出 openEntryModal', !!modalSrc);
const mKeys = [...modalSrc.matchAll(/\{ key: '([^']+)'/g)].map((m) => m[1]);
const mi = (k) => mKeys.indexOf(k);
ok('弹窗字段里抠得到三样', mi('title') >= 0 && mi('tvg-id') >= 0 && mi('group') >= 0, mKeys.join('|'));
ok('弹窗：tvg-id 紧跟频道名', mi('tvg-id') === mi('title') + 1, mKeys.join('|'));
ok('弹窗：tvg-id 在分组之前', mi('group') === mi('tvg-id') + 1, mKeys.join('|'));

// 三处必须说的是同一件事，否则就是「表头改了、行里没改」这种半截改动
ok(
  '表头 / 行内 / 弹窗三处顺序一致',
  at('c-name') + 1 === at('c-tvg') &&
    rowFields[1] === 'tvg-id' &&
    mKeys[mi('tvg-id')] === 'tvg-id' &&
    mKeys[mi('group')] === 'group',
);

/* ============ 4. 那条提示：从文档流里的横幅改成底部浮层 ============ */

const barCss = CSS.slice(CSS.indexOf('.raisebar{'), CSS.indexOf('.raisebar[hidden]'));
ok('CSS 里抠得到 .raisebar', !!barCss && barCss.length > 20);
ok('它已经脱离文档流（fixed）', /position:\s*fixed/.test(barCss), barCss.slice(0, 60));
ok('它贴在视口底部', /bottom:\s*\d+px/.test(barCss));
ok(
  '不再占文档流那一行（早先是 flex:none 的一行横幅）',
  !/flex:\s*none/.test(barCss) && !/border-bottom/.test(barCss),
);
ok('按钮还点得动（没像 toast 那样吃掉指针事件）', /pointer-events:\s*auto/.test(barCss));
ok('z-index 压在 toast 上面（两者同处底部，浮层后出）', /z-index:\s*7\d/.test(barCss));

// 顺手确认它没留在 body 的纵向流里白占一格
const bodyRule = /^body\{[^}]*\}/m.exec(CSS);
ok('body 仍是纵向 flex（浮层不该参与它）', !!bodyRule && /flex-direction:\s*column/.test(bodyRule[0]));

/* ============ 5. 出场时要收掉 toast，别两条叠在同一处 ============ */

const showSrc = grabFn('function showRaiseBar(msg) {');
ok('源码里能抠出 showRaiseBar', !!showSrc);
ok('浮层出场时先收掉底部 toast', /hideToast\(\)/.test(showSrc));

const box = {};
const $ = (sel) => {
  if (sel === '#raiseBar') {
    box.bar = box.bar || { hidden: true };
    return box.bar;
  }
  if (sel === '#raiseMsg') {
    box.msg = box.msg || { textContent: '' };
    return box.msg;
  }
  return null;
};
let hideCalled = 0;
const hideToast = () => {
  hideCalled++;
};
const showRaiseBar = new Function('$', 't', 'hideToast', 'state', `${showSrc}\nreturn showRaiseBar;`)(
  $,
  ident,
  hideToast,
  { player: {} }, // 没配播放器时这条出口本来就不该冒出来
);
box.bar = { hidden: true };
showRaiseBar('窗口被盖住了');
ok('浮层浮出来了', box.bar.hidden === false);
ok('出场顺手把 toast 收了', hideCalled === 1, String(hideCalled));
ok('文案写进去了', box.msg.textContent === '窗口被盖住了', box.msg.textContent);

box.bar = { hidden: false };
showRaiseBar('');
ok('没给文案时退回默认那句', /声音在放，画面看不见/.test(box.msg.textContent), box.msg.textContent);

/* ============ 6. hideToast 本身 ============ */

const hideSrc = grabFn('function hideToast() {');
ok('源码里能抠出 hideToast', !!hideSrc);
const el = { textContent: '', _on: false, classList: { add() {}, remove() { el._on = false; } } };
const box2 = { toast: el };
// toastTimer 是模块级那个待摘类的定时器，桩里给个空对象就够了 —— 这里只关心 on 类有没有被摘掉
const hideToastRun = new Function('$', 'clearTimeout', 'toastTimer', `${hideSrc}\nreturn hideToast;`)(
  (s) => (s === '#toast' ? box2.toast : null),
  () => {},
  {},
);
el._on = true;
hideToastRun();
ok('hideToast 摘掉 on 类（提示就淡掉了）', el._on === false);

console.log(`\nlayout: ${pass} 项通过，${failed} 项失败`);
process.exit(failed ? 1 : 0);
