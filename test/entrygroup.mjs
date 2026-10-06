/**
 * 「添加 / 编辑 / 批量改分组」时，分组框既要有列表里已有的分组可选、又得能随便手打。
 *
 * 单选框和输入框打架，是因为两者互相锁死（选了就不能打字、打了就不能选）。
 * 这里用的是原生 input + datalist —— 它本就是「可输入的下拉」：候选只负责补全，
 * 输入框从头到尾是个普通输入框，两者根本不互斥，也不用在界面上放开关。
 *
 * 这台机器没装浏览器，所以用「从源码抽出函数 + DOM 桩」的办法真跑一遍渲染，
 * 不是重抄一份模板（重抄的测试跟生产代码会各走各的）。
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

/** 按花括号配对抠出一段函数体（字符串里的花括号也计入，靠配对抵消） */
function grabFn(head) {
  const i = APP.indexOf(head);
  if (i < 0) throw new Error('源码里没找到: ' + head);
  let depth = 0;
  for (let j = APP.indexOf('{', i); j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}') {
      if (--depth === 0) return APP.slice(i, j + 1);
    }
  }
  throw new Error('花括号没配对: ' + head);
}

// esc 那行尾部是对象字面量的 }，按花括号配对会提前截，按行收
const escSrc = APP.match(/const esc = [\s\S]*?\);/)[0];

let html = '';
const $ = (s) =>
  s === '#modalFields'
    ? { set innerHTML(v) { html = v; }, get innerHTML() { return html; } }
    : { focus() {}, classList: { remove() {}, add() {} } };

const openModal = new Function('t', '$', `${escSrc}\n${grabFn('function openModal(title, fields, onOk) {')}\nreturn openModal;`)((s) => s, $);

/* ---------------- 1. 渲染：可输入的下拉 ---------------- */

const fields = [
  { key: 'title', label: '频道显示名', value: '' },
  { key: 'group', label: '分组 group-title', value: '央视', datalist: ['央视', '地方台', '香港频道', '和 & <>"引号'] },
  { key: 'url', label: '播放地址', value: 'http://x/a.m3u8', type: 'textarea' },
];
html = '';
openModal('添加新频道', fields, () => {});

console.log('分组字段渲染结果：');
console.log('      ' + (html.split('\n').find((l) => l.includes('data-k="group"')) || '(没找到)') + '\n');

ok('input 挂上了 datalist', /<input[^>]*data-k="group"[^>]*list="mpm-dl-group"/.test(html));
ok('datalist 带对应 id', /<datalist id="mpm-dl-group">/.test(html));
ok('候选就是传入的分组列表', [...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]).includes('香港频道'));

const rawOpt = [...html.matchAll(/<option value="[^"]*"/g)].map((m) => m[0]).find((s) => /&/.test(s)) || '';
ok('候选里的尖括号/引号被转义（不会注入 HTML）', /&lt;/.test(rawOpt) && /&quot;/.test(rawOpt) && !/</.test(rawOpt.slice(9)), rawOpt);
ok('输入框仍是可自由打字的普通 input', /<input[^>]*data-k="group"[^>]*type="text"/.test(html) && !/disabled|readonly/.test(html));
ok('textarea 字段没被误加 list', !/<textarea[^>]*list=/.test(html));

/* ---------------- 2. 候选来源：现有分组，且不含占位文案 ---------------- */

const groupChoices = new Function(
  'state',
  'grpOf',
  `${grabFn('function groupChoices() {')}\nreturn groupChoices;`,
);
const grpOf = (e) => e.attrMap['group-title'] || '';
const state = {
  entries: [
    { attrMap: { 'group-title': '央视' } },
    { attrMap: { 'group-title': '央视' } },
    { attrMap: { 'group-title': '地方台' } },
    { attrMap: {} }, // 没分组的不该跑出来当候选
    { attrMap: { 'group-title': '' } },
  ],
};
const choices = groupChoices(state, grpOf)();

ok('候选去重', new Set(choices).size === choices.length, JSON.stringify(choices));
ok('候选排除「（未分组）」这种界面占位文案', !choices.some((g) => g.includes('未分组')));
ok('候选排除真正的空值', choices.length === 2 && choices.every((g) => g), JSON.stringify(choices));

/* ---------------- 3. 新增频道时继承当前筛选的分组 ---------------- */

const fieldsSrc = APP.match(/const fields = \[[\s\S]*?\n  \];/)[0];
const openEntryFields = (isNew, entry, group) =>
  new Function(
    'isNew',
    'entry',
    'state',
    't',
    'grpOf',
    'nameOf',
    'idOf',
    'logoOf',
    'groupChoices',
    `${escSrc}\n${fieldsSrc}\nreturn fields;`,
  )(
    isNew,
    entry,
    { group },
    (s) => s,
    grpOf,
    (e) => e.title,
    (e) => '',
    (e) => '',
    groupChoices(state, grpOf),
  );

const groupFieldOf = (fs) => fs.find((f) => f.key === 'group');

{
  const f = groupFieldOf(openEntryFields(true, null, '地方台'));
  ok('新增时预填当前筛选的分组', f.value === '地方台', JSON.stringify(f.value));
  ok('新增时分组字段带候选', Array.isArray(f.datalist) && f.datalist.length === 2, JSON.stringify(f.datalist));
  ok('新增时没预填 → 分组留空', groupFieldOf(openEntryFields(true, null, '')).value === '');
}
{
  const entry = { title: 'x', url: '', attrMap: { 'group-title': '香港频道' } };
  const f = groupFieldOf(openEntryFields(false, entry, ''));
  ok('编辑时带出这条频道的原分组', f.value === '香港频道', JSON.stringify(f.value));
  ok('编辑时同样有候选可选', Array.isArray(f.datalist) && f.datalist.length === 2);
}

console.log(`\n${failed === 0 ? '全部通过' : '有用例失败'}（${pass} 项）`);
process.exit(failed === 0 ? 0 : 1);
