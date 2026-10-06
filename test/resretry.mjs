/**
 * 「补测没读到的 N 条」：⟳ 按钮只该长在该长的地方。
 *
 * 起因：探测现在会把「分辨率为什么空着」分好类，但界面上仍是把所有空着的条目
 * 一视同仁地给一个重挖入口。可纯音频台、源站没写这类，给多大窗口都不可能有分辨率，
 * 挂个按钮让人白点一次，点完还是「—」，比不挂更糟。
 *
 * 所以这里钉死两件事：
 *   1) ⟳ 只出现在 long-gop / seg-fail 上（视频轨在、只是关键帧没盖到，或分片没取到）
 *   2) 工具栏那个批量按钮：有靶子才显形，没靶子整个藏起来；点下去走 4MB 深挖，
 *      跑完给出「挖到几条 / 还差几条、都是什么类型」的一句话汇总
 *
 * 抠 app.js 源码 + DOM 桩跑，不重抄一份实现。
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

/** 从源码里抠一段（抠不到就是测试跟着实现一起改坏了，得报出来） */
const grab = (re, what) => {
  const m = APP.match(re);
  if (!m) throw new Error(`源码里抠不出 ${what}，测试该跟着实现一起更新`);
  return m[0];
};

const SRC = [
  grab(/const RES_RETRYABLE = new Set\(\[[^\]]*\]\);/, 'RES_RETRYABLE'),
  grab(/const NO_RES_LABEL = \{[\s\S]*?\n\};/, 'NO_RES_LABEL'),
  grab(/const DEEP_PROBE_BYTES = [^;]*;/, 'DEEP_PROBE_BYTES'),
  grab(/const resCell = \(p\) => \{[\s\S]*?\n\};/, 'resCell'),
  grab(/const resBusyCell = \(\) =>\s*\n?\s*`[^`]*`;/, 'resBusyCell'),
  grab(/function explainNoRes\(p\) \{[\s\S]*?\n\}/, 'explainNoRes'),
  grab(/function noResBlindNote\(\) \{[\s\S]*?\n\}/, 'noResBlindNote'),
  grab(/const resRetryList = \(\) =>\s*\n?\s*state\.entries\.filter\([^;]*\);/, 'resRetryList'),
  grab(/function syncResRetryBtn\(\) \{[\s\S]*?\n\}/, 'syncResRetryBtn'),
  grab(/function retryResSummary\(attempted\) \{[\s\S]*?\n\}/, 'retryResSummary'),
  grab(/function retryRes\(entries, \{ batch = false \} = \{\}\) \{[\s\S]*?\n\}/, 'retryRes'),
].join('\n\n');

/* ---------------- 桩 ---------------- */

const ident = (s, o) => String(s).replace(/\{(\w+)\}/g, (_, k) => String((o && o[k]) ?? ''));

function build(entries, { confirmYes = true } = {}) {
  const state = { entries };
  const calls = { probe: [], busy: [], confirm: [] };
  const btn = { textContent: '', title: '', hidden: false, classList: { toggle: (_c, on) => (btn.hidden = !!on) } };
  const $ = (sel) => (sel === '#btnRetryRes' ? btn : null);
  const cells = new Map();
  const document = {
    querySelector(sel) {
      const hit = sel.match(/data-id="([^"]+)"/);
      if (!hit) return null;
      if (!cells.has(hit[1])) cells.set(hit[1], { innerHTML: '' });
      return cells.get(hit[1]);
    },
  };
  const confirm = (msg) => {
    calls.confirm.push(msg);
    return confirmYes;
  };
  const probe = (ids, opts) => calls.probe.push({ ids, opts });

  const api = new Function(
    'state',
    't',
    'esc',
    '$',
    'document',
    'confirm',
    'probe',
    `${SRC}\nreturn { resCell, resBusyCell, resRetryList, syncResRetryBtn, retryResSummary, retryRes, explainNoRes, noResBlindNote, RES_RETRYABLE, DEEP_PROBE_BYTES };`,
  )(state, ident, (s) => String(s), $, document, confirm, probe);

  const { resCell, ...rest } = api;
  return { ...rest, resCell, state, calls, btn, cells };
}

/** 造一个探测过的条目；probe 字段照抄服务端给的东西 */
const entry = (id, probe) => ({ id, title: id, url: `http://x/${id}.ts`, probe });
const probed = (id, over) => ({ ok: true, format: '', noRes: '', noResText: '', note: '', ...over });

console.log('⟳ 局部重挖');

/* ---------------- 1. 幼儿园：只有该挖的才挂按钮 ---------------- */
{
  const h = build([]);
  const cell = (p) => h.resCell(p);

  ok('读到分辨率的行：不挂 ⟳', !/resretry/.test(cell(probed('a', { format: '1920x1080', width: 1920, height: 1080 }))));
  ok('探测失败的行：不挂 ⟳', !/resretry/.test(cell({ ok: false, format: '' })));

  const gop = cell(probed('a', { noRes: 'long-gop', noResText: '视频轨在、关键帧没盖到' }));
  ok('long-gop（关键帧太远）：挂 ⟳', /data-act="resretry"/.test(gop) && /⟳/.test(gop), gop);
  ok('long-gop 的 ⟳ 有 tooltip 说明为什么值得重挖', /原因：视频轨在、关键帧没盖到/.test(gop) && /4MB/.test(gop), gop);
  ok('可挖那类的 tooltip 把「点 ⟳ 去挖」也写了（不用再点开看）', /点这个 ⟳/.test(gop), gop);

  const seg = cell(probed('a', { noRes: 'seg-fail', noResText: '分片没取到' }));
  ok('seg-fail（分片没取到）：也挂 ⟳', /data-act="resretry"/.test(seg), seg);

  // 纯音频台：三个字直接替代「— + ?」，不必再让人点一下问「为什么不挖」
  const audio = cell(probed('a', { noRes: 'audio-only', noResText: '这条流只有音频、没有视频轨' }));
  ok('纯音频台：格子里直接写「纯音频」', /class="res low res-audio"[^>]*>纯音频</.test(audio), audio);
  ok('纯音频台：不挂 ⟳（点了也白挖）', !/resretry/.test(audio), audio);
  ok('纯音频台：也不挂「?」（三个字已经把原因说完了）', !/noreswhy/.test(audio), audio);
  ok('纯音频台：hover 那三个字仍看得到「只有音频」的原因', /这条流只有音频/.test(audio), audio);

  const note = cell(probed('a', { noRes: 'm3u-note', noResText: '源站压根没写分辨率' }));
  ok('源站没写的：不挂 ⟳（物理上没有）', !/resretry/.test(note), note);
  ok('源站没写的：同样挂「?」', /data-act="noreswhy"/.test(note), note);
  ok('源站没写的：tooltip 明说重挖也没用', /重挖也没用|压根没写/.test(note), note);
  ok('不可挖那类的 tooltip 也把「再挖也没用」写全了（悬停一次读完）', /原因：源站压根没写分辨率/.test(note), note);

  ok('没测过的行：⟳ 和 ? 都不挂', !/resretry/.test(cell(null)) && !/noreswhy/.test(cell(null)));

  // 服务端跑着旧版本时压根没有 noRes —— 这一格不能又变回光秃秃的「—」
  const blind = cell(probed('a', {}));
  ok('服务端没回报原因（旧版本服务）：也留一个「?」', /data-act="noreswhy"/.test(blind), blind);

  // 转圈那格（补测跑着）不该同时挂着两个按钮
  ok(
    '补测那一格（⌛）既不挂 ⟳ 也不挂 ?',
    !/resretry/.test(h.resBusyCell()) && !/noreswhy/.test(h.resBusyCell()),
    h.resBusyCell(),
  );
}

/* ---------------- 2. 靶子名单 ---------------- */
{
  const h = build([
    entry('a', probed('a', { noRes: 'long-gop' })),
    entry('b', probed('b', { noRes: 'audio-only' })),
    entry('c', probed('c', { noRes: 'm3u-note' })),
    entry('d', probed('d', { noRes: 'seg-fail' })),
    entry('e', probed('e', { format: '1920x1080', width: 1920, height: 1080 })),
    entry('f', { ok: false, format: '', noRes: 'long-gop' }),
  ]);
  const ids = h.resRetryList().map((e) => e.id);
  ok('靶子名单只挑 long-gop / seg-fail', ids.join(',') === 'a,d', ids.join(','));
  ok('纯音频 / 源站没写 / 读到了 / 探测失败的都不算靶子',
     !ids.includes('b') && !ids.includes('c') && !ids.includes('e') && !ids.includes('f'), ids.join(','));
}

/* ---------------- 3. 工具栏那个批量按钮 ---------------- */
{
  const h = build([entry('a', probed('a', { noRes: 'long-gop' })), entry('b', probed('b', { noRes: 'seg-fail' }))]);
  h.syncResRetryBtn();
  ok('有 2 个靶子 → 显示「↻ 补测没读到的 2 条」', h.btn.textContent === '↻ 补测没读到的 2 条', h.btn.textContent);
  ok('有靶子时按钮是显示的', h.btn.hidden === false);
  ok('tooltip 讲清了每条 4MB / 25 秒', /4MB|25 秒/.test(h.btn.title), h.btn.title);

  h.state.entries = [entry('a', probed('a', { noRes: 'audio-only' }))];
  h.syncResRetryBtn();
  ok('靶子清零（比如刚补测完）→ 按钮藏起来', h.btn.hidden === true);
  ok('藏起来时文案也清掉，不留上一次的数字', h.btn.textContent === '', h.btn.textContent);

  const noBtn = new Function(
    'state', 't', 'esc', '$', 'document', 'confirm', 'probe',
    `${SRC}\nreturn syncResRetryBtn;`,
  )({ entries: [] }, ident, (s) => String(s), () => null, {}, () => true, () => {});
  let threw = null;
  try {
    noBtn();
  } catch (e) {
    threw = e;
  }
  ok('页面上没有 #btnRetryRes（按钮被隐藏）时不报错', threw === null, threw && threw.message);
}

/* ---------------- 4. 单条 ⟳：先转圈、再走 4MB 深挖 ---------------- */
{
  const h = build([entry('a', probed('a', { noRes: 'long-gop' }))]);
  h.retryRes([h.state.entries[0]]);
  ok('点 ⟳ 时那一格先变成转圈（防连点）', /⌛/.test(h.cells.get('a').innerHTML), h.cells.get('a').innerHTML);
  ok('转圈那格不再挂着 ⟳ 按钮', !/resretry/.test(h.cells.get('a').innerHTML), h.cells.get('a').innerHTML);
  ok('只重挖点中的那一条', h.calls.probe.length === 1 && h.calls.probe[0].ids.join() === 'a',
     JSON.stringify(h.calls.probe.map((c) => c.ids)));
  ok('单条重挖破例顶到 4MB', h.calls.probe[0].opts.bytes === 4 * 1048576, String(h.calls.probe[0].opts.bytes));
  ok('单条重挖给足超时（25 秒）', h.calls.probe[0].opts.timeout === 25000, String(h.calls.probe[0].opts.timeout));
  ok('单条重挖不带批量确认（一行不弹窗烦人）', h.calls.confirm.length === 0);
  ok('跑完给一句汇总，而不是另弹「已自动选中」那套', /挖到分辨率/.test(h.calls.probe[0].opts.doneMsg || ''),
     h.calls.probe[0].opts.doneMsg);
}

/* ---------------- 5. 批量：先确认一次，别一写就挖一片 ---------------- */
{
  const h = build([entry('a', probed('a', { noRes: 'long-gop' })), entry('b', probed('b', { noRes: 'seg-fail' }))]);
  h.retryRes(h.resRetryList(), { batch: true });
  ok('批量发起前先确认', h.calls.confirm.length === 1, String(h.calls.confirm.length));
  ok('确认里讲清 4MB / 25 秒的代价', /4MB/.test(h.calls.confirm[0]) && /25 秒/.test(h.calls.confirm[0]), h.calls.confirm[0]);
  ok('确认后两条一起重挖', h.calls.probe.length === 1 && h.calls.probe[0].ids.join(',') === 'a,b',
     JSON.stringify(h.calls.probe.map((c) => c.ids)));
  ok('两行都换成转圈', /⌛/.test(h.cells.get('a').innerHTML) && /⌛/.test(h.cells.get('b').innerHTML));

  // 用户在确认框里点了取消：不该挖、也不该把行改成转圈
  const h2 = build([entry('a', probed('a', { noRes: 'long-gop' }))], { confirmYes: false });
  h2.retryRes(h2.resRetryList(), { batch: true });
  ok('确认被取消：一条都不挖', h2.calls.probe.length === 0, String(h2.calls.probe.length));
  const cellHtml = (h, id) => (h.cells.has(id) ? h.cells.get(id).innerHTML : '');
  ok('确认被取消：行里还是原来的样子（没变成转圈）', !/⌛/.test(cellHtml(h2, 'a')), cellHtml(h2, 'a'));
}

/* ---------------- 6. 汇总：跑完这一句就知道「4MB 还兜不住的是哪类」 ---------------- */
{
  const h = build([
    entry('a', probed('a', { format: '1920x1080', width: 1920, height: 1080 })),
    entry('b', probed('b', { format: '1920x1080', width: 1920, height: 1080 })),
    entry('c', probed('c', { noRes: 'audio-only', noResText: '只有音频' })),
    entry('d', probed('d', { noRes: 'audio-only', noResText: '只有音频' })),
    entry('e', probed('e', { noRes: 'long-gop', noResText: '关键帧太远' })),
  ]);
  const msg = h.retryResSummary(5);
  ok('汇总说清挖到几条', /挖到分辨率 2 条/.test(msg), msg);
  ok('汇总说清还剩几条', /仍没读到 3 条/.test(msg), msg);
  ok('汇总按数量从多到少列出原因（纯音频 2 · 关键帧太远 1）', /纯音频 2 条 · 关键帧太远 1 条/.test(msg), msg);
  ok('汇总里带上一共补了几条', /这 5 条/.test(msg), msg);

  const empty = build([]);
  ok('一条都没剩下时汇总不留空白括号', /（—）/.test(empty.retryResSummary(0)), empty.retryResSummary(0));
}

/* ---------------- 6.5 「?」点开要说人话：哪类值得挖、哪类别挖 ---------------- */
{
  const h = build([]);
  ok('long-gop：说明原因 + 指一下 ⟳ 能再挖（并讲清 4MB）',
     /原因：关键帧太远/.test(h.explainNoRes({ ok: true, format: '', noRes: 'long-gop', noResText: '关键帧太远' })) &&
     /4MB/.test(h.explainNoRes({ ok: true, format: '', noRes: 'long-gop', noResText: '关键帧太远' })),
     h.explainNoRes({ ok: true, format: '', noRes: 'long-gop', noResText: '关键帧太远' }));
  const audio = h.explainNoRes({ ok: true, format: '', noRes: 'audio-only', noResText: '只有音频' });
  ok('纯音频：说清原因，并点明「再挖也不会有分辨率」', /只有音频/.test(audio) && /不会/.test(audio), audio);

  // 这条最容易误导：服务端没回报原因时，不能让用户对着「—」猜
  const blind = h.explainNoRes({ ok: true, format: '', noRes: '', noResText: '' });
  ok('服务端没回报原因：直说多半是服务跑着旧版本，重启后再测', /重启/.test(blind), blind);

  ok('探测失败的行：点「?」说清是没拿到码流',
     /压根没拿到码流/.test(h.explainNoRes({ ok: false, format: '', note: '超时' })),
     h.explainNoRes({ ok: false, format: '', note: '超时' }));
  ok('没探测过的行：点「?」说还没探测', /还没探测过/.test(h.explainNoRes(null)));
  ok('读到分辨率的行：点「?」报出分辨率（不该还当它是问题）',
     /1920x1080/.test(h.explainNoRes({ ok: true, format: '1920x1080', width: 1920, height: 1080 })));
}

/* ---------------- 6.6 归因盲区提醒：所有「在线但没读到」都没原因时点破 ---------------- */
{
  const blind = build([entry('a', probed('a', {})), entry('b', probed('b', {}))]);
  const note = blind.noResBlindNote();
  ok('有 2 条在线但没读到、且都没原因 → 提醒「服务可能没重启」', /2 条/.test(note) && /重启/.test(note), note);

  const mixed = build([entry('a', probed('a', {})), entry('b', probed('b', { noRes: 'long-gop', noResText: 'x' }))]);
  ok('只要有一条报了原因，就不必再说一遍「服务没重启」', mixed.noResBlindNote() === '', mixed.noResBlindNote());

  const none = build([entry('a', probed('a', { format: '1080p', width: 1920, height: 1080 }))]);
  ok('全都读到分辨率 → 不提醒', none.noResBlindNote() === '');

  const dead = build([entry('a', { ok: false, format: '', note: '超时' })]);
  ok('全是探测失败（根本不在线）→ 不提醒', dead.noResBlindNote() === '');
}

/* ---------------- 7. 刷新入口：三处都得跟着重算 ---------------- */
{
  const renderSrc = APP.match(/function render\(\) \{[\s\S]*?\n\}/)[0];
  const syncSelSrc = APP.match(/function syncSelectionUI\(\) \{[\s\S]*?\n\}/)[0];
  ok('render() 里会重算按钮（探测跑完走这里）', /syncResRetryBtn\(\)/.test(renderSrc));
  ok('syncSelectionUI() 里会重算按钮（补测结果回来、改条目都走）', /syncResRetryBtn\(\)/.test(syncSelSrc));
  ok('行内 ⟳ 的 click 分支走的是 retryRes([e])',
     /act === 'resretry'[\s\S]{0,220}retryRes\(\[e\]\)/.test(APP));
  // 「?」不再弹底部那一闪而过的提示条（三行根本读不完），改成就地展开成常驻浮层
  ok('行内「?」的 click 分支把归因就地展开、再点一下收起',
     /act === 'noreswhy'[\s\S]{0,320}td\.classList\.toggle\('resopen'\)[\s\S]{0,200}respop/.test(APP));
  ok('展开的那一块就挂在同一格里（不跑到底部去）',
     /td\.innerHTML = open[\s\S]{0,220}resCell/.test(APP));
  ok('收起时还原成原来那个分辨率格', /resCell\(e && e\.probe\)/.test(APP));
  ok('两种图标的 tooltip 都是完整归因（悬停一次读完，不用点开）',
     (APP.match(/title="\$\{esc\(explainNoRes\(p\)\)\}"/g) || []).length === 2);
  ok('探测收尾会带上归因盲区提醒',
     /const extra = noResBlindNote\(\)/.test(APP) && /extra \?/.test(APP) && /\$\{extra\}/.test(APP));
  ok('工具栏按钮的 click 带 batch（会先确认一次）',
     /#btnRetryRes'\)\.addEventListener\('click', \(\) => retryRes\(resRetryList\(\), \{ batch: true \}\)\)/.test(APP));
}

console.log(failed ? `\n[⟳局部重挖] ${failed} 项失败（通过 ${pass}）` : `\n[⟳局部重挖] 全部通过（${pass} 项）`);
process.exit(failed ? 1 : 0);
