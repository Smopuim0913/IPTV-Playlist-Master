/**
 * 表格行的拖动开关：按在「频道名 / 分组 / tvg-id」这些输入框上，必须能正常定光标、拖选文本；
 * 按在 ⠿ 把手、序号、LOGO、地址、状态格子上，照旧能直接把整行拖走。
 *
 * 起因：以前 <tr draggable="true"> 是写死在行上的，浏览器就把整行连里面的 input 一起
 * 当成拖影源 —— 在输入框里按住左键拖，拖的是整行，文本选不中、光标也钉不住。
 * 现在改成「按下那一刻才开」，所以这里既验渲染出来的行不带 draggable，
 * 也把 mousedown / mouseup 两个监听真的跑一遍。
 *
 * 这台机器没浏览器，用「抠源码 + DOM 桩」跑，不重抄一份实现。
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
const escSrc = APP.match(/const esc = [\s\S]*?\);/)[0];
const ident = (s) => s;

/* ---------------- 1. 渲染出来的行：不再默认 draggable ---------------- */

const RENDER_SRC = APP.slice(APP.indexOf('/** LOGO 该不该在这行显示'), APP.indexOf('/** 底部那两行统计'));
const state = {
  selected: new Set(),
  brokenLogos: new Set(),
  player: '/usr/bin/vlc',
};
const rowHtml = new Function(
  't',
  'state',
  'nameOf',
  'grpOf',
  'idOf',
  'logoOf',
  `${escSrc}\n${RENDER_SRC}\nreturn rowHtml;`,
)(ident, state, (e) => e.title, (e) => e.attrMap['group-title'] || '', (e) => e.attrMap['tvg-id'] || '', (e) => e.attrMap['tvg-logo'] || '');

const html = rowHtml(
  { id: 'e1', title: 'CCTV-1', url: 'http://x/a.m3u8', attrMap: { 'group-title': '央视', 'tvg-id': 'cctv1', 'tvg-logo': 'http://x/l.png' } },
  0,
);
const trTag = html.slice(0, html.indexOf('>') + 1);

console.log('行首渲染结果：' + trTag);

ok('行上不再写死 draggable="true"（写死会让整行连输入框一起被拖走）', !/draggable="?true/i.test(trTag), trTag);
ok('行本身还带着 data-id（拖动逻辑靠它找行）', /data-id="/.test(trTag));
ok('LOGO 的 img 关掉了原生图片拖拽（否则从 LOGO 起手拖的是图片）', /<img[^>]*draggable="false"/.test(html));
ok('三个输入框都在（频道名 / 分组 / tvg-id）', (html.match(/class="cellinp"/g) || []).length === 3);
ok('频道名输入框还是普通 input，没有 draggable', !/<input[^>]*class="cellinp"[^>]*draggable/i.test(html));

/* ---------------- 2. 按下时该不该拖整行 ---------------- */

const canDragRowSrc = APP.match(/const canDragRow = [^\n]*/)[0];
const canDragRow = new Function(`${canDragRowSrc}\nreturn canDragRow;`)();

// 贴图：把「命中哪些选择器」给全，closest 就按这个答
const NO_DRAG_SEL = canDragRowSrc.match(/'([^']*)'/)[1];
const on = (...sels) => ({ closest: (sel) => (sel === 'tr[data-id]' ? {} : sels.includes(sel) ? {} : null) });

ok('按在频道名输入框上 → 不拖（要让光标和拖选文本生效）', canDragRow(on(NO_DRAG_SEL, 'input')) === false);
ok('按在分组输入框上 → 不拖', canDragRow(on(NO_DRAG_SEL, 'input')) === false);
ok('按在 tvg-id 输入框上 → 不拖', canDragRow(on(NO_DRAG_SEL, 'input')) === false);
ok('按在复选框上 → 不拖（勾选优先）', canDragRow(on(NO_DRAG_SEL, 'input')) === false);
ok('按在 ✎/⧉ 按钮上 → 不拖（点击优先）', canDragRow(on(NO_DRAG_SEL, 'button')) === false);
ok('按在 ⠿ 把手上 → 拖整行', canDragRow(on()) === true);
ok('按在序号上 → 拖整行', canDragRow(on()) === true);
ok('按在 LOGO 上 → 拖整行', canDragRow(on()) === true);
ok('按在地址文本上 → 拖整行', canDragRow(on()) === true);
ok('按在状态 chip 上 → 拖整行', canDragRow(on()) === true);

/* ---------------- 3. mousedown / mouseup 真的跑一遍 ---------------- */

const mousedownSrc = APP.match(/\$\('#tbody'\)\.addEventListener\('mousedown', \(ev\) => \{[\s\S]*?\n\}\);/)[0];
const mouseupSrc = APP.match(/\$\('#tbody'\)\.addEventListener\('mouseup', \(ev\) => \{[\s\S]*?\n\}\);/)[0];
const listeners = (dragId) => {
  const h = {};
  new Function(
    '$',
    'canDragRow',
    'dragId',
    `const H = {};\n${mousedownSrc}\n${mouseupSrc}\nreturn H;`,
  )(() => ({ addEventListener(k, fn) { h[k] = fn; } }), canDragRow, dragId);
  return h;
};

const tr = () => ({ dataset: { id: 'e1' }, draggable: false, classList: { add() {}, remove() {} } });
/** noDrag=true 表示按在输入框/按钮这类元素上（canDragRow 的那条选择器会命中） */
const press = (list, dragId = null, noDrag = false) => {
  const t = tr();
  const ev = {
    target: { closest: (sel) => (sel === 'tr[data-id]' ? t : sel === NO_DRAG_SEL && noDrag ? {} : null) },
  };
  if (list.mousedown) list.mousedown(ev);
  return t;
};

{
  const list = listeners(null);
  ok('mousedown 确实挂上了', typeof list.mousedown === 'function');
  ok('mouseup 确实挂上了', typeof list.mouseup === 'function');

  ok('在频道名输入框按下 → 这一行不开拖动开关', press(list, null, true).draggable === false);
}
{
  const list = listeners(null);
  const t2 = press(list, null);
  ok('在 ⠿ 把手按下 → 这一行才开拖动开关', t2.draggable === true);
  // 只是点一下、没真拖：抬手就该收回去
  list.mouseup({ target: { closest: () => t2 } });
  ok('抬手（没拖动）→ 开关收回去', t2.draggable === false);
}
{
  // 正在拖的时候抬起（某些浏览器会补一个 mouseup）不该提前收开关，交给 dragend 收
  const list = listeners('e1');
  const t3 = tr();
  t3.draggable = true;
  list.mouseup({ target: { closest: () => t3 } });
  ok('正在拖动中的 mouseup 不抢 dragend 的活', t3.draggable === true && t3.dataset.id === 'e1');
}

console.log(`\n${failed === 0 ? '全部通过' : '有用例失败'}（${pass} 项）`);
process.exit(failed === 0 ? 0 : 1);
