import { serializeM3U, parseM3U, parseExtinf, decodeBuffer, detectEncoding, isM3U8Name, stripBom } from '/module/m3u.js';
import { rebuildName, rebuildResName, stripDelaySuffix, stripResSuffix, stripAllSuffix, delaySuffix } from '/module/suffix.js';
import { sortSameNameByDelay, movedCount } from '/module/sort.js';
import { mergePlaylist } from '/module/merge.js';
import { t, applyStatic, onLangChange, mountLangSwitch } from '/public/i18n.js';

const $ = (s) => document.querySelector(s);
const MAX_RENDER = 500;

/**
 * 当前进行中的 SSE 连接（探测 / 补测共用一个），「停止」和「换列表」都靠它掐断。
 * 放在这里而不是探测那一节，是让 adopt() 也能在模块最前面就安全地调用 stopProbeUI()
 * （函数声明会提升，但它引用的这个变量不能还压在文件后半段的 let 上）。
 */
let activeEs = null;

const state = {
  doc: null, // parseM3U 产出的整份文档，导出时原样序列化回去
  entries: [], // 实时频道数组（增删排序都作用在这里）
  path: null,
  srcName: '',
  srcUrl: '', // 上次「从源站更新」用过的地址，下次省得再填一遍
  encoding: 'utf-8',
  encodingWarn: '',
  q: '',
  group: '',
  selected: new Set(),
  brokenLogos: new Set(), // 图片加载失败（或压根没 LOGO）的频道，行内要显示 [+]
  fullUrl: false, // 「完整地址」开关：窄列截断 vs 整行换行
  players: [], // 本机扫到的播放器（含用户手动指定的那个）
  player: null, // 当前选中的播放器记录
};

// 「从源站更新」记住上次填的地址，下次省得再敲一遍
try {
  state.srcUrl = localStorage.getItem('mpm.srcUrl') || '';
} catch {}

/**
 * 统一入口：把 parseM3U 的结果挂到 state 上，然后刷新界面。
 * doc.entries 与 state.entries 指向同一数组，避免「表格显示的和导出的是两回事」。
 */
function adopt(doc, { path = null, srcName = '', encoding = 'utf-8' } = {}) {
  // 换列表 = 换一批被测对象：还在跑的那一趟必须就地掐掉。
  //
  // 早先这里只换数据、不碰探测，于是「探测到一半再导一份列表」会留下三堆烂摊子：
  //   ① 旧队列继续给已经不存在的一批 id 发请求，白烧源站流量（几百条就是几百个包）；
  //   ② 进度条停在中途不走，看着像还在跑；
  //   ③ 旧队列跑完那句「探测完成：N 条」是按**它自己那一批**算的，却会落到新表头上：
  //      自动勾上「失败项」、底栏计数、汇总条数全错（新表压根没测过）。
  // 所以这一步放在替换 state 之前 —— 那一批 ⌛ 单元格也要能借它还原回 ⟳。
  const stopped = stopProbeUI();
  state.doc = doc;
  state.entries = doc.entries;
  state.path = path;
  state.srcName = srcName;
  state.encoding = encoding;
  state.selected.clear();
  state.brokenLogos.clear();
  state.encodingWarn = encoding !== 'utf-8'
    ? t('原文件为 {encoding} 编码，保存/导出时会统一输出为 UTF-8', { encoding })
    : '';
  warn(state.encodingWarn);
  $('#srcLabel').textContent = t('{name} · 共 {n} 个频道', { name: srcName, n: doc.entries.length });
  $('#pathInput').value = path || '';
  $('#empty').classList.add('hidden');
  $('#tableWrap').classList.remove('hidden');
  $('#btnSave').disabled = !path;
  for (const b of ['btnExportM3U', 'btnExportM3U8']) $(`#${b}`).disabled = false;
  refreshGroupOptions();
  render();
  // 真有一趟被掐掉才吭声，否则每导一次列表都弹一句 Toast，很快就成了噪音
  if (stopped) toast(t('已载入新列表，上一趟探测已停止，进度已清空'));
}

/** 非 UTF-8 列表的提示条，只在有内容时显示 */
function warn(msg) {
  const el = $('#warn');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

/** 把当前列表登记到服务端，探测接口要用 id / url */
async function registerWithServer() {
  await fetch('/api/load', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: state.path,
      name: state.srcName,
      entries: state.entries.map((e) => ({ id: e.id, url: e.url })),
    }),
  });
}

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nameOf = (e) => e.title || e.attrMap['tvg-name'] || '';
const grpOf = (e) => e.attrMap['group-title'] || '';
const idOf = (e) => e.attrMap['tvg-id'] || '';
const logoOf = (e) => e.attrMap['tvg-logo'] || '';

function setAttr(e, key, val) {
  const a = e.attrs.find((x) => x.key === key);
  if (a) {
    a.value = val;
    a.raw = `${key}="${val}"`;
    e.attrMap[key] = val;
  } else {
    e.attrs.push({ key, value: val, raw: `${key}="${val}"` });
    e.attrMap[key] = val;
  }
  if (key === 'group-title') e.attrMap['group-title'] = val;
}

/**
 * 记一下「这个字段是用户手改过的」。
 * 「从源站更新」要用它来挡住远端覆盖 —— 本地手动换过地址，就不该被源站再刷回去。
 */
function markTouched(e, field) {
  if (!e.touched) e.touched = new Set();
  e.touched.add(field);
}

/** 写 LOGO：留空时把属性整个摘掉（留个 tvg-logo="" 只会让播放器多打一次 404） */
function setLogo(e, url) {
  url = String(url || '').trim();
  if (!url) {
    const i = e.attrs.findIndex((x) => x.key === 'tvg-logo');
    if (i >= 0) e.attrs.splice(i, 1);
    delete e.attrMap['tvg-logo'];
    return;
  }
  setAttr(e, 'tvg-logo', url);
  markTouched(e, 'logo');
}

const visible = () => {
  const q = state.q.trim().toLowerCase();
  return state.entries.filter((e) => {
    if (state.group && grpOf(e) !== state.group) return false;
    if (q) {
      const hay = [e.title, e.attrMap['tvg-id'], e.attrMap['tvg-name'], e.url, e.attrMap['tvg-logo']]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
};

/* ---------------- 通用小工具 ---------------- */

/** 轻量提示：比 alert 冷静，探测/复制这类高频操作不该每回都弹框打断 */
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 1800);
}

/** 把那条一闪而过的提示立刻收掉（底部浮层要出场时用它腾地方） */
function hideToast() {
  const el = $('#toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.classList.remove('on');
}

/**
 * 复制到剪贴板。
 * navigator.clipboard 只在「安全上下文」下可用（localhost 算，局域网 http 不算），
 * 所以必须留一条 execCommand 的老路，否则从手机/局域网打开时会静默失败。
 */
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** LOGO 该不该在这行显示 [+]：压根没地址，或地址挂了（onerror 记进 brokenLogos） */
const logoBad = (e) => !logoOf(e) || state.brokenLogos.has(e.id);
const LOGO_ADD_BTN =
  '<button class="btn sm logoadd" data-act="logo" title="' + esc(t('补一个 LOGO 地址')) + '">[+]</button>';

/** 有可用播放器才在行尾给 ▶；播放器设置里存了自定义路径就一直有 */
const PLAY_BTN =
  '<button class="btn sm playbtn" data-act="play" title="' + esc(t('用本机播放器打开这条流')) + '">▶</button>';

/* ---------------- 渲染 ---------------- */

/**
 * 「分辨率读不到」时，什么样的条目值得再挖一次。
 *
 * 和服务端 NO_RES_TEXT 是同一套分类（前端拿到的字段就是那个 reason）。
 * 只有这两类给 ⟳ 按钮：视频轨明明在、只是探测窗口没盖到关键帧（long-gop），
 * 或者压根没取到分片（seg-fail，换个时刻重挖可能就命中）。
 * 纯音频台、源站压根没写这类，按钮点了也是白花流量，干脆不出现。
 */
const RES_RETRYABLE = new Set(['long-gop', 'seg-fail']);

/** 补测汇总里把 reason 翻成人话（走字典，别硬编码中文） */
const NO_RES_LABEL = {
  'audio-only': t('纯音频'),
  'no-video': t('没视频轨'),
  // 这一窗没带 PAT/PMT ≠ 没视频轨。早期这两种混成一个「没视频轨」，
  // 于是实测 112.123.243.37 那条 1080p 直播被判成「源站流描述里就没有视频」，
  // 连重挖入口都不给 —— 分辨率和流内服务名就一起丢了。
  'no-psi': t('表在更后面'),
  'no-pmt': t('结构认不出'),
  'long-gop': t('关键帧太远'),
  'seg-fail': t('分片取不到'),
  'm3u-note': t('源站没写'),
  'no-data': t('没拿到码流'),
};

/** 局部重挖这一趟愿意往下读多少字节（比探测惯用的 64KB 大得多） */
const DEEP_PROBE_BYTES = 4 * 1048576;

/** 探测跑完，进度条在 100% 上停留多久再自动收起（毫秒） */
const PROGRESS_HOLD_MS = 1400;

const resCell = (p) => {
  if (!p || !p.ok) return '<span class="res low">—</span>';
  // 「直播直连流」是流类型不是分辨率，别混进这一列（类型信息保留在状态列的说明里）
  if (!p.format) {
    // 纯音频台：结论直接写进格子 —— 没视频轨 → 不可能有分辨率 → 挂 ⟳ 是白烧流量。
    // 再加一个「?」纯属多余：这三个字已经把「为什么空着、为什么不用挖」说完了
    // （话说回来，完整原因还是挂在 tooltip 上，悬停照样看得到）。
    if (p.noRes === 'audio-only') {
      return `<span class="res low res-audio" title="${esc(
        p.noResText || t('这条流只有音频、没有视频轨，再挖多深也读不出分辨率'),
      )}">${esc(t('纯音频'))}</span>`;
    }
    // 流内服务名长短差得远（dftvHD 到「Phoenix … Chinese Channel .z0」一整句都有），
    // 所以只当**参考信息**挂在 tooltip 上，原样显示不清洗、不截断。
    const tip =
      (p.noResText ? `${p.noResText} · ` : '') +
      (p.serviceName ? `${t('流内服务名：{n}', { n: p.serviceName })} · ` : '') +
      (p.note || '');
    // 能挖的和不能挖的都要有个图标 —— 光秃秃一个「—」看不出这条是有救还是没救。
    // ⟳ 点下去真会去挖；「?」只负责把「为什么没有」讲清楚。
    // 两种都把完整原因直接写进 title：悬停一次就能读完，不用点开去看那一闪而过的提示条。
    const btn = RES_RETRYABLE.has(p.noRes)
      ? `<button class="btn sm resretry" data-act="resretry" title="${esc(explainNoRes(p))}">⟳</button>`
      : `<button class="btn sm reswhy" data-act="noreswhy" title="${esc(explainNoRes(p))}">?</button>`;
    return `<span class="res low" title="${esc(tip)}">—</span> ${btn}`;
  }
  const tip =
    (p.serviceName ? ` · ${t('流内服务名：{n}', { n: p.serviceName })}` : '') + (p.note ? ` · ${p.note}` : '');
  const cls = p.stallRisk === 'high' ? 'mid' : 'high';
  return `<span class="res ${cls}" title="${esc(tip)}">${esc(p.format)}</span>`;
};

/** 这条正在补测中（⟳ 变转圈），别再给按钮让人连点两遍 */
const resBusyCell = () =>
  `<span class="res low resbusy" title="${esc(t('正在用更大的窗口重挖…'))}">⌛</span>`;

/**
 * 「这一行为什么没有分辨率」要说的话：第一行讲原因，第二行讲该怎么办。
 *
 * 不能只丢一句「纯音频」完事 —— 得顺带说清**该不该再挖**，否则用户看到 ⟳ 会去点、
 * 看到「—」会纳闷是不是漏了什么。
 * 还有一种情况是服务端压根没回报原因（服务跑着旧版本，改了 src 没重启），
 * 这种得直说，不然只能对着一个「—」瞎猜。
 *
 * 用 \n 分行：这一段同时喂给图标的 title（悬停即看完）和点开后的就地浮层，
 * 所以**一次就得给全** —— 以前那种底部提示条一闪而过、三行还来不及读完的做法没了。
 */
function explainNoRes(p) {
  if (!p) return t('这条还没探测过');
  if (!p.ok) {
    return `${t('这条探测就失败了：{note}', { note: p.note || '' })}\n${t('压根没拿到码流，谈不上分辨率')}`;
  }
  if (p.format) return t('这条读到分辨率了：{fmt}', { fmt: p.format });
  if (!p.noRes) {
    return `${t('服务端这一趟没回报没读到分辨率的原因（多半是服务跑着旧版本，改了代码得重启服务）')}\n${t('重启后再测一次，这里就会显示原因和 ⟳ 按钮')}`;
  }
  const why = p.noResText || NO_RES_LABEL[p.noRes] || p.noRes;
  // no-psi 和 long-gop 都给 ⟳，但「往下读」换回来的东西不一样：
  // 前者缺的是节目信息表（ PAT/PMT/SDT 可能在 1MB 之后），后者缺的是关键帧。
  // 一句「只是探测窗口没盖到关键帧」是错的，会把人误导成「再挖也白挖」。
  if (p.noRes === 'no-psi') {
    return `${t('原因：{why}（这一窗连节目信息表都没扫到，不代表没视频轨）', { why })}\n${t(
      '点这个 ⟳ 用更大的窗口（每条最多 {mb}MB 往下读）继续往里找',
      { mb: DEEP_PROBE_BYTES / 1048576 },
    )}`;
  }
  return RES_RETRYABLE.has(p.noRes)
    ? `${t('原因：{why}（视频轨在，只是探测窗口没盖到关键帧）', { why })}\n${t(
        '点这个 ⟳ 用更大的窗口（每条最多 {mb}MB 往下读）重挖一次',
        { mb: DEEP_PROBE_BYTES / 1048576 },
      )}`
    : t('原因：{why}。这一类再往深挖也不会有分辨率，所以只给说明、不给重挖按钮', { why });
}

/**
 * 这一趟探测有没有「归因盲区」：有条目在线但没读到分辨率，却一条原因都没回报。
 *
 * noRes 是服务端这一轮才加的，跑着旧版本的服务会一条都不给。这种情况必须点破 ——
 * 否则界面上就是一排没有任何线索的「—」，看着像这个功能压根没做。
 */
function noResBlindNote() {
  const left = state.entries.filter((e) => e.probe && e.probe.ok && !e.probe.format);
  if (!left.length || left.some((e) => e.probe.noRes)) return '';
  return t(
    '有 {n} 条在线但没读到分辨率，一次原因都没回报 —— 多半是服务跑着旧版本（改了代码要重启服务），重启后再测一次，这些格子上就会显示原因和 ⟳ 按钮',
    { n: left.length },
  );
}
const delayCell = (p) => {
  if (!p || !p.ok) return '<span class="delay low">—</span>';
  const ms = p.ttfbMs || 0;
  const w = Math.min(100, (ms / 1000) * 100);
  return `<span class="delay"><span class="metric-bar"><i style="width:${w}%;background:${
    ms > 600 ? 'var(--bad)' : ms > 250 ? 'var(--warn)' : 'var(--ok)'
  }"></i></span>${ms}ms</span>`;
};
/**
 * 「标称码率」这一格：显示的是**源站在主清单里标的 BANDWIDTH**（bandwidthMbps），
 * 不是实测吞吐。
 *
 * 为什么换成标称：实测吞吐要拿 64KB 样本去除以传输时间，以 HLS 直播为主的列表上
 * 几乎测不出数（主清单一律不算、样本不足 32KB 也不算），实测下来 26 条在线只有
 * 一条非零还是 0.01M 的噪音 —— 这一列常年挂一排「—」。而标称码率是源站自己写的，
 * 只要主清单带 BANDWIDTH 就一定有一个数，横着比也有意义（挑码率小的源更不容易卡）。
 * 实测值没丢：塞进 tooltip，和「卡顿预判」一起显示。
 */
const mbpsCell = (p) => {
  if (!p || !p.ok) return '<span class="delay low">—</span>';
  if (!p.bandwidthMbps) return '<span class="delay low" title="' + esc(t('这条没读到标称码率')) + '">—</span>';
  const cls = p.stallRisk === 'high' ? 'var(--bad)' : p.stallRisk === 'mid' ? 'var(--warn)' : 'var(--ok)';
  const measured = p.mbps > 0 ? ` · ${esc(t('实测 {n}M', { n: p.mbps }))}` : '';
  const risk = p.stallRisk ? ` · ${esc(t('卡顿预判：{n}', { n: stallRiskText(p.stallRisk) }))}` : '';
  const tip = esc(t('源站标称 {n}M', { n: p.bandwidthMbps })) + measured + risk;
  return `<span class="mbps" style="color:${cls}" title="${tip}">${p.bandwidthMbps}M</span>`;
};
const stallRiskText = (r) => (r === 'high' ? t('容易卡') : r === 'mid' ? t('勉强够用') : t('够用'));

/**
 * 「流内名」这一格：TS 流里 SDT（PID 17）那个节目名，探测顺手读出来的。
 *
 * 命中率不高（实测 12%，且命中的多半是 ffmpeg 转流的模板名），名字还可能长到一整句，
 * 所以格子**不铺文本**，只放两个小图标：ⓘ 悬停/点开看完整名，⧉ 点一下复制整段。
 * 没读到（没探测 / 探测失败 / 流里没写 SDT）就一个「—」，跟别的空格一个观感。
 */
const sdtCell = (p) => {
  if (!p || !p.ok || !p.serviceName) return '<span class="sdtlow">—</span>';
  const name = t('流内服务名：{n}', { n: p.serviceName });
  return (
    `<button class="btn sm sdticon" data-act="sdtwhy" title="${esc(t('流内名：{n}', { n: p.serviceName }))}">ⓘ</button>` +
    `<button class="btn sm sdtcopy" data-act="sdtcopy" title="${esc(t('复制完整流内名'))}">⧉</button>`
  );
};
const stateCell = (p) => {
  if (!p) return `<span class="pill none">${esc(t('未测'))}</span>`;
  if (!p.ok) {
    // 失败时把人话放正文、把原始错误码和重试次数放 tooltip，方便排查「是不是被误判」
    const tip = t('原始错误码：{code}；共尝试 {attempts} 次（重试 {retried} 次仍失败）', {
      code: p.code || 'N/A',
      attempts: p.attempts,
      retried: p.retried,
    });
    return `<span class="pill bad" title="${esc(tip)}">${esc(p.note || p.code || t('失败'))}</span>`;
  }
  if (p.status >= 400) return `<span class="pill bad" title="${esc(p.note || '')}">${esc(p.note || p.code)}</span>`;
  // 伪直播：能连上、分辨率也读得到，可源是段录好的循环片（带二维码的引流短片，
  // 一分钟一循环）。它比「在线」更该被人看见 —— 挂在这栏里只会白占一个真频道。
  if (p.fakeLive)
    return `<span class="pill fake" title="${esc(t('不是实时直播：{why}', { why: p.fakeLiveWhy || '' }))}">${esc(
      t('循环片'),
    )}</span>`;
  // 假源第二路：几段历史切片缝起来假装成直播（没有 ENDLIST，看着跟真直播一模一样，
  // 分辨率延迟全都正常），播到窗口末尾就没下一片、画面卡死。跟上面那枚紫色不是一回事：
  // 循环片是「录播短片在循环」，这个是「滚动窗口已经停更」，认的标志（紫色 vs 冷蓝）也不同。
  if (p.seamLive)
    return `<span class="pill seam" title="${esc(p.seamLiveWhy || '')}">${esc(t('拼接'))}</span>`;
  // 证书校验不过但源其实能播 —— 标黄提示，别一棍子打成死链
  // 状态码只出现一次：以前外层再拼一遍 `${p.status || 200}`、里面 t() 又占一个 {status}，
  // 渲染出来是「200 200 在线」。现在整句走字典，status 由 {status} 占位符填。
  if (p.tlsInsecure)
    return `<span class="pill warn" title="${esc(p.note || '')}">${esc(
      t('{status} · 证书异常但可播', { status: p.status || 200 }),
    )}</span>`;
  if (p.stallRisk === 'high' || (p.ttfbMs || 0) > 3000)
    return `<span class="pill warn" title="${esc(p.note || '')}">${esc(
      t('{status} · 易卡顿', { status: p.status || 200 }),
    )}</span>`;
  return `<span class="pill ok" title="${esc(p.note || '')}">${esc(
    t('{status} 在线', { status: p.status || 200 }),
  )}</span>`;
};

/** 流地址太长会把表格撑歪，默认只露个头尾；完整内容在 title 里，勾「完整地址」可换行全展开 */
const shortUrl = (u) => {
  const s = String(u || '');
  if (s.length <= 56) return s;
  return `${s.slice(0, 34)}…${s.slice(-16)}`;
};

function rowHtml(e, i) {
  const sel = state.selected.has(e.id) ? ' checked' : '';
  const logoCell = logoBad(e)
    ? `<td class="c-logo">${LOGO_ADD_BTN}</td>`
    : `<td class="c-logo"><img class="logo" src="${esc(logoOf(e))}" loading="lazy" draggable="false" alt="" data-id="${e.id}"></td>`;
  // 这里刻意不给 <tr> 写 draggable="true"：行可拖的开关是按下时才开的（见下面的 mousedown），
  // 写死在行上的话，浏览器会把整行连里面的输入框一起当可拖对象，
  // 在「频道名 / 分组 / tvg-id」里按住左键拖就是拖整行，选不中文本、光标也定不住。
  // LOGO 那张 img 单独关掉原生图片拖拽，否则从 LOGO 起手拖的是图片而不是这一行。
  return `<tr data-id="${e.id}"${sel ? ' class="sel"' : ''}>
  <td class="c-chk"><input type="checkbox" data-act="sel"${sel}></td>
  <td class="handle" data-act="handle" title="${esc(t('拖动排序'))}">⠿</td>
  <td class="num">${i + 1}</td>
  ${logoCell}
  <!-- 顺序跟表头、编辑弹窗保持一致：频道名 → tvg-id → 分组。
       tvg-id 紧贴频道名右边（它俩是一条频道的「叫什么」和「对应哪个节目 ID」），
       分组挪到它后面，一眼看过去先认频道、再认身、最后认归到哪堆。 -->
  <td><input class="cellinp" data-f="title" value="${esc(nameOf(e))}" placeholder="${esc(t('频道名'))}"></td>
  <td><input class="cellinp" data-f="tvg-id" value="${esc(idOf(e))}" placeholder="tvg-id"></td>
  <td><input class="cellinp" data-f="group" list="grouplist" value="${esc(grpOf(e))}" placeholder="${esc(t('分组'))}"></td>
  <td class="c-url"><span class="urltext" title="${esc(e.url || '')}">${esc(shortUrl(e.url)) || '—'}</span><button class="btn sm" data-act="copy" title="${esc(t('复制这条流地址'))}">⧉</button></td>
  <td data-c="res">${resCell(e.probe)}</td>
  <td data-c="sdt">${sdtCell(e.probe)}</td>
  <td data-c="delay">${delayCell(e.probe)}</td>
  <td data-c="mbps">${mbpsCell(e.probe)}</td>
  <td data-c="state">${stateCell(e.probe)}</td>
  <td class="c-act">${state.player ? PLAY_BTN : ''}<button class="btn sm" data-act="edit">✎</button></td>
</tr>`;
}

/** 底部那两行统计，好几处都要算，抽出来免得各自写一套 */
function statText() {
  const list = visible();
  const ok = list.filter((e) => e.probe && e.probe.ok).length;
  const bad = list.filter((e) => e.probe && !e.probe.ok).length;
  return t('{shown} / 共 {total} 条 · 已选 {sel} · 在线 {ok} / 失败 {bad}', {
    shown: list.length,
    total: state.entries.length,
    sel: state.selected.size,
    ok,
    bad,
  });
}

/**
 * 浏览器自己能不能播 HLS —— 只有 Safari / iOS 系的原生 <video> 认 application/vnd.apple.mpegurl，
 * Chrome、Edge、Firefox 桌面版都不认（它们要把 m3u8 交给 hls.js 之类第三方库才能播，
 * 本项目零依赖，不引）。所以这条只当兜底：能播就弹窗播，不能播就走本机播放器。
 */
const BROWSER_HLS = (() => {
  const v = document.createElement('video');
  return !!(v.canPlayType && (v.canPlayType('application/vnd.apple.mpegurl') || v.canPlayType('application/x-mpegURL')));
})();

/**
 * 工具栏那个 ▶ 的文案 —— 只有真的选中了才带条数，没选中就退回基础文案。
 *
 * 之前这段只在 syncSelectionUI 里算，而「删除选中频道」走的是 render()：
 * 选区早空了、按钮却还挂着刚删掉的那个数字。反过来也不对 —— 没选中时
 * pickTargets() 等于整表，一重算就变成 (整表条数)，看着像点下去要排几百条。
 * 所以抽成单独一处，render / 勾选 / 删除 / 清空选区都会重算。
 */
function syncPlayBtn() {
  const btn = $('#btnPlaySel');
  if (!btn) return;
  const pool = state.selected.size
    ? state.entries.filter((e) => state.selected.has(e.id))
    : state.entries;
  const n = pool.filter((e) => /^https?:\/\//i.test((e.url || '').trim())).length;
  // 编号只跟着「选中的」走：没选中时不标注条数（点了确实是排整表，但那一步会先弹确认，
  // 把整表条数挂在按钮上只会让人以为刚删完频道还选着东西）
  const many = state.selected.size > 0 && n > 1 && !BROWSER_HLS;
  btn.textContent = many ? t('▶ 排进一个窗口 ({n})', { n }) : t('▶ 用播放器打开');
  btn.title = many
    ? t('这 {n} 条排进同一个播放器窗口，在窗口里轮流播（一次只出一路声，不会混）', { n })
    : state.selected.size
      ? t('调起本机播放器打开所选频道（可先在设置里选播放器）')
      : t('没选就按整表 {n} 条排进同一个播放器窗口（一次只出一路声，点下去会先确认一次）', { n });
}

/**
 * 「还没读到分辨率、但值得再挖一次」的条目。
 *
 * 这是局部重挖的靶子名单：探测把「为什么没读到」分好类之后，
 * 名单里就只剩 long-gop / seg-fail 这两类（见 RES_RETRYABLE）。
 */
const resRetryList = () =>
  state.entries.filter((e) => e.probe && e.probe.ok && !e.probe.format && RES_RETRYABLE.has(e.probe.noRes));

/**
 * 工具栏那个「补测没读到的 N 条」—— 没有值得补的条目就整个藏起来，
 * 免得界面上挂一个点了没反应的按钮。探测结束、单条重挖完成、改完条目都要重算。
 */
function syncResRetryBtn() {
  const btn = $('#btnRetryRes');
  if (!btn) return;
  const n = resRetryList().length;
  btn.textContent = n ? t('↻ 补测没读到的 {n} 条', { n }) : '';
  btn.title = n
    ? t('对这 {n} 条逐个用更大的窗口重读流头（每条最多 4MB、独立超时 25 秒），挖到关键帧就补上分辨率', { n })
    : '';
  btn.classList.toggle('hidden', !n);
}

/**
 * 只把「选中态」刷到 DOM 上，不重建表格。
 * 探测一批结果回来、手动勾复选框之后都用这个 —— 整表 innerHTML 重写会让滚动位置和
 * 输入框焦点一起跳，批量操作的时候特别难受。
 */
function syncSelectionUI() {
  document.querySelectorAll('#tbody tr[data-id]').forEach((tr) => {
    const on = state.selected.has(tr.dataset.id);
    const cb = tr.querySelector('input[data-act="sel"]');
    if (cb) cb.checked = on;
    tr.classList.toggle('sel', on);
  });
  const list = visible();
  const selAll = $('#selAll');
  if (selAll) selAll.checked = list.length > 0 && list.every((e) => state.selected.has(e.id));
  $('#stat').textContent = statText();
  syncPlayBtn();
  syncResRetryBtn();
}

let dragId = null;

function render() {
  const list = visible();
  const shown = list.slice(0, MAX_RENDER);
  const tbody = $('#tbody');
  tbody.innerHTML = shown.length
    ? shown.map(rowHtml).join('')
    : '<tr><td colspan="13" style="color:var(--muted);padding:20px">' + esc(t('没有匹配的频道')) + '</td></tr>';

  // 图片加载失败事件不冒泡，只能逐个挂（inline onerror 在 innerHTML 里又不好管）；
  // 挂上之后把这个行降级成 [+]，用户就能就地补地址，不用改完再整表刷新。
  tbody.querySelectorAll('img.logo').forEach((img) => {
    img.addEventListener('error', () => {
      const id = img.dataset.id;
      if (logoOf(state.entries.find((x) => x.id === id))) state.brokenLogos.add(id);
      const td = img.closest('td');
      if (td) td.innerHTML = LOGO_ADD_BTN;
    });
  });

  const moreEl = $('#more');
  if (list.length > MAX_RENDER) {
    moreEl.classList.remove('hidden');
    moreEl.textContent = t('共 {total} 条，此处仅渲染前 {max} 条（批量操作与导出均作用于全部）。继续输入关键词可缩小范围。', {
      total: list.length,
      max: MAX_RENDER,
    });
  } else {
    moreEl.classList.add('hidden');
  }

  $('#stat').textContent = statText();
  const ok = state.entries.filter((e) => e.probe && e.probe.ok).length;
  const bad = state.entries.filter((e) => e.probe && !e.probe.ok).length;
  $('#probeStat').textContent = t('已测 {done}（在线 {ok} / 失败 {bad}）', { done: ok + bad, ok, bad });
  // 探测跑完，没读到的条目里哪些还值得补，心里得有个数（按钮要不要冒出来）
  syncResRetryBtn();
  // 删除频道、批量改完走的都是 render()，按钮文案得跟着选区一起重算 ——
  // 否则刚删掉 3 条，按钮还挂着「▶ 排进一个窗口 (3)」，一条都不剩却看着像还选着。
  syncPlayBtn();
}

function refreshGroupOptions() {
  const map = new Map();
  for (const e of state.entries) map.set(grpOf(e) || t('（未分组）'), (map.get(grpOf(e) || t('（未分组）')) || 0) + 1);
  const cur = state.group;
  $('#groupSel').innerHTML =
    '<option value="">' + esc(t('全部分组')) + '</option>' +
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([g, n]) => `<option value="${esc(g)}">${esc(g)} (${n})</option>`)
      .join('');
  if (cur) $('#groupSel').value = cur;

  let dl = document.getElementById('grouplist');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'grouplist';
    document.body.appendChild(dl);
  }
  dl.innerHTML = [...map.keys()].map((g) => `<option value="${esc(g)}">`).join('');
}

/**
 * 当前列表里出现过的真实分组名，给「添加 / 编辑频道」「批量改分组」的分组框当补全候选。
 * 刻意不收「（未分组）」—— 那是界面上的占位文案，落进 m3u 会变成真分组名。
 */
function groupChoices() {
  const set = new Set();
  for (const e of state.entries) {
    const g = grpOf(e);
    if (g) set.add(g);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function updateRow(e) {
  const tr = document.querySelector(`#tbody tr[data-id="${e.id}"]`);
  if (!tr) return;
  tr.querySelector('[data-c="res"]').innerHTML = resCell(e.probe);
  tr.querySelector('[data-c="sdt"]').innerHTML = sdtCell(e.probe);
  tr.querySelector('[data-c="delay"]').innerHTML = delayCell(e.probe);
  tr.querySelector('[data-c="mbps"]').innerHTML = mbpsCell(e.probe);
  tr.querySelector('[data-c="state"]').innerHTML = stateCell(e.probe);
}

/**
 * 只换这一行的 LOGO 单元格 —— 补完地址不该把整张表重建（会丢焦点、滚动也会跳）。
 * @param {boolean} broken 传 true 表示写入失败，继续显示 [+]
 */
function refreshLogoCell(e, broken = false) {
  const tr = document.querySelector(`#tbody tr[data-id="${e.id}"]`);
  if (!tr) return;
  const td = tr.querySelector('td.c-logo');
  if (!td) return;
  if (broken || logoBad(e)) {
    state.brokenLogos.add(e.id);
    td.innerHTML = LOGO_ADD_BTN;
    return;
  }
  state.brokenLogos.delete(e.id);
  td.innerHTML = `<img class="logo" src="${esc(logoOf(e))}" loading="lazy" alt="" data-id="${e.id}">`;
}

/* ---------------- 载入 ---------------- */

/** base64 -> 字节（前端没有 Buffer，得自己拆） */
function b64ToBytes(b64) {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

// paste / file 传入的原文（b64 或纯文本），前端自己解析，保证「看到的」就是「导出的」
async function loadPayload({ b64, text, name, path }) {
  if (b64) {
    const content = decodeBuffer(b64ToBytes(b64));
    if (!content.trim()) return alert(t('内容为空'));
    adopt(parseM3U(content), { path: path || null, srcName: name || t('粘贴内容') });
  } else {
    if (!text || !text.trim()) return alert(t('内容为空'));
    adopt(parseM3U(text), { path: path || null, srcName: name || t('粘贴内容') });
  }
  registerWithServer();
}

/* ---------------- 事件：表格 ---------------- */

$('#tbody').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'resretry') {
    const e = state.entries.find((x) => x.id === btn.closest('tr').dataset.id);
    if (!e) return;
    retryRes([e]);
    return;
  }
  // 「?」：把「这条为什么没有分辨率」讲清楚（归因 + 该不该再挖），别只甩一个「—」。
  // 就地展开成一小块常驻浮层，再点一下收起 —— 底部那条提示 1.8 秒自己就没了，
  // 三行归因根本读不完（以前还得反复点开才能看全）。
  if (act === 'noreswhy') {
    const e = state.entries.find((x) => x.id === btn.closest('tr').dataset.id);
    if (!e) return;
    const td = btn.closest('td');
    if (!td) return;
    const open = td.classList.toggle('resopen');
    td.innerHTML = open
      ? `<span class="respop" data-act="noreswhy" title="${esc(t('再点一下收起'))}">${esc(
          explainNoRes(e.probe),
        )}</span>`
      : resCell(e && e.probe);
    return;
  }
  // ⓘ：流内名可能长到一整句，光靠 title 悬停才能看见，点一下把它摊开成一小块常驻浮层。
  // 与「?」一个路子（再点收起），别用底部那条一闪而过的提示条。
  if (act === 'sdtwhy') {
    const e = state.entries.find((x) => x.id === btn.closest('tr').dataset.id);
    if (!e || !e.probe || !e.probe.serviceName) return;
    const td = btn.closest('td');
    if (!td) return;
    td.classList.toggle('sdtopen');
    td.innerHTML = td.classList.contains('sdtopen')
      ? `<span class="respop sdtpop" data-act="sdtwhy" title="${esc(t('再点一下收起'))}">${esc(
          t('流内名：{n}', { n: e.probe.serviceName }),
        )}\n${esc(t('点右边的 ⧉ 复制整段'))}</span>`
      : sdtCell(e.probe);
    return;
  }
  if (act === 'edit' || act === 'copy' || act === 'logo' || act === 'play') {
    const e = state.entries.find((x) => x.id === btn.closest('tr').dataset.id);
    if (!e) return;
    if (act === 'play') {
      await openInPlayer(e);
    } else if (act === 'sdtcopy') {
      const ok = await copyText(e.probe && e.probe.serviceName ? String(e.probe.serviceName).trim() : '');
      toast(ok ? t('已复制流内名') : t('复制失败，请手动选中（或用「编辑频道」复制）'));
    } else if (act === 'copy') {
      const ok = await copyText(e.url || '');
      toast(ok ? t('已复制流地址') : t('复制失败，请手动选中（或用「编辑频道」复制）'));
    } else if (act === 'logo') {
      openLogoModal(e);
    } else {
      openEntryModal(e, { focus: 'url' });
    }
  }
});

$('#tbody').addEventListener('change', (ev) => {
  const cb = ev.target.closest('input[data-act="sel"]');
  if (cb) {
    const id = cb.closest('tr').dataset.id;
    cb.checked ? state.selected.add(id) : state.selected.delete(id);
    $('#stat').textContent = statText();
    syncPlayBtn(); // 不重建表格，所以按钮文案得手动跟着走
  }
});

$('#tbody').addEventListener('input', (ev) => {
  const inp = ev.target.closest('input.cellinp');
  if (!inp) return;
  const e = state.entries.find((x) => x.id === inp.closest('tr').dataset.id);
  if (!e) return;
  const f = inp.dataset.f;
  if (f === 'title') e.title = inp.value;
  else setAttr(e, f, inp.value);
  markTouched(e, f === 'group' ? 'group' : f);
  if (f === 'group') refreshGroupOptions();
  state.doc.dirty = true;
});

$('#tbody').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.classList.contains('cellinp')) ev.target.blur();
});

/**
 * 「这一行现在能不能被拖走」—— 按在哪个元素上决定。
 *
 * 从输入框（频道名 / 分组 / tvg-id）、按钮（⧉ / ✎ / ▶）、复选框起手时返回 false，
 * 交给输入框自己处理：定光标、拖选文本、勾选；其余格子（⠿ 把手、序号、LOGO、
 * 地址、分辨率/延迟/状态…）照旧能直接拖整行，和以前「整行 draggable」的手感一致。
 */
const canDragRow = (target) => !target.closest('input, textarea, select, button, a, [contenteditable]');

// 拖动开关只在按下那一刻开着：直接给 <tr> 挂 draggable="true" 会让浏览器把整行
// （含里面的 input）都当拖影源，输入框里的文本就选不中了。
$('#tbody').addEventListener('mousedown', (ev) => {
  const tr = ev.target.closest('tr[data-id]');
  if (!tr) return;
  tr.draggable = canDragRow(ev.target);
});
$('#tbody').addEventListener('mouseup', (ev) => {
  if (dragId) return; // 真拖完了，等 dragend 统一收
  const tr = ev.target.closest('tr[data-id]');
  if (tr && tr.draggable) tr.draggable = false; // 只是点了一下，开关收回去
});

let dragTargetInfo = null;
$('#tbody').addEventListener('dragstart', (ev) => {
  const tr = ev.target.closest('tr');
  if (!tr || !tr.dataset.id) return;
  dragId = tr.dataset.id;
  tr.classList.add('dragging');
  ev.dataTransfer.effectAllowed = 'move';
  try { ev.dataTransfer.setData('text/plain', tr.dataset.id); } catch {}
});
$('#tbody').addEventListener('dragend', () => {
  document.querySelectorAll('#tbody tr.dragging').forEach((x) => {
    x.classList.remove('dragging');
    x.draggable = false;
  });
  dragId = null;
});
$('#tbody').addEventListener('dragover', (ev) => {
  if (!dragId) return;
  ev.preventDefault();
  const tr = ev.target.closest('tr');
  if (!tr || tr.dataset.id === dragId) return;
  document.querySelectorAll('#tbody tr.over').forEach((x) => x.classList.remove('over'));
  tr.classList.add('over');
  const vis = visible().map((e) => e.id);
  dragTargetInfo = { targetId: tr.dataset.id, after: vis.indexOf(dragId) > vis.indexOf(tr.dataset.id) };
});
$('#tbody').addEventListener('drop', (ev) => {
  ev.preventDefault();
  const info = dragTargetInfo;
  document.querySelectorAll('#tbody tr.over').forEach((x) => x.classList.remove('over'));
  if (!info || !dragId) return;
  const from = state.entries.findIndex((x) => x.id === dragId);
  if (from < 0) return;
  const [item] = state.entries.splice(from, 1);
  let ti = state.entries.findIndex((x) => x.id === info.targetId);
  if (ti < 0) return;
  state.entries.splice(info.after ? ti + 1 : ti, 0, item);
  state.doc.dirty = true;
  render();
});

/* ---------------- 事件：工具栏 ---------------- */

$('#q').addEventListener('input', (ev) => {
  state.q = ev.target.value;
  render();
});
$('#groupSel').addEventListener('change', (ev) => {
  state.group = ev.target.value;
  render();
});
$('#selAll').addEventListener('change', (ev) => {
  if (ev.target.checked) visible().forEach((e) => state.selected.add(e.id));
  else visible().forEach((e) => state.selected.delete(e.id));
  render();
});

$('#btnSelBad').addEventListener('click', () => {
  state.selected.clear();
  state.entries.filter((e) => e.probe && !e.probe.ok).forEach((e) => state.selected.add(e.id));
  render();
});

$('#btnClearSel').addEventListener('click', () => {
  state.selected.clear();
  syncSelectionUI();
});

/**
 * 伪直播（其实是录好的循环片）整批选中。
 *
 * 这类源在探测结论上「挑不出毛病」—— 200 在线、分辨率也读得到，
 * 唯一的破绽是它在时间上根本没在走，所以只能靠状态列那枚紫色「循环片」认。
 * 让人一条条点着删不现实，这里跟着「选中缺 LOGO 的」一起给个批量入口。
 */
$('#btnSelFake').addEventListener('click', () => {
  state.selected.clear();
  const n = state.entries.filter((e) => e.probe && e.probe.fakeLive).length;
  state.entries.filter((e) => e.probe && e.probe.fakeLive).forEach((e) => state.selected.add(e.id));
  render();
  toast(n ? t('已选中 {n} 个伪直播（循环片）', { n }) : t('没挑出伪直播（循环片）'));
});

/**
 * 「缝起来的假直播」整批选中。跟上面「选中伪直播」是两路毛病：
 * 那路是带二维码的录播短片在循环（清单封了口），这路是滚动窗口已经停更、
 * 放到最后一片就卡死（清单没封口）。探测结论上它俩都「挑不出毛病」，
 * 所以各配一个批量入口，选完一起批量删。
 */
$('#btnSelSeam').addEventListener('click', () => {
  state.selected.clear();
  const hit = state.entries.filter((e) => e.probe && e.probe.seamLive);
  hit.forEach((e) => state.selected.add(e.id));
  render();
  toast(hit.length ? t('已选中 {n} 个拼接的假直播', { n }) : t('没挑出拼接的假直播'));
});

/** 缺 LOGO 的（没地址或图挂了）整批选中，接着就能批量补 */
$('#btnSelNoLogo').addEventListener('click', () => {
  state.selected.clear();
  const n = state.entries.filter((e) => logoBad(e)).length;
  state.entries.filter((e) => logoBad(e)).forEach((e) => state.selected.add(e.id));
  render();
  toast(n ? t('已选中 {n} 个缺 LOGO 的频道', { n }) : t('每个频道都有 LOGO 了'));
});

$('#chkFullUrl').addEventListener('change', (ev) => {
  state.fullUrl = ev.target.checked;
  document.querySelector('table.grid').classList.toggle('fullurl', state.fullUrl);
});

/**
 * 复制地址 —— 往第三方播放器里手动加源时最常用：
 * 选中几条 → 复制 → 粘贴到 VLC/PlayerX 里，一行一个。
 */
$('#btnCopyUrls').addEventListener('click', async () => {
  if (!state.entries.length) return alert(t('先载入播放列表'));
  const list = pickTargets();
  const urls = list.map((e) => (e.url || '').trim()).filter(Boolean);
  if (!urls.length) return alert(t('这些频道没有流地址'));
  const ok = await copyText(urls.join('\n'));
  toast(
    ok
      ? t('已复制 {n} 条流地址（{skip} 条为空已跳过）', { n: urls.length, skip: list.length - urls.length })
      : t('复制失败，可能是浏览器限制了剪贴板'),
  );
});

/* ---------------- 本机播放器 ---------------- */

/**
 * 把一条流交给本机播放器。
 * 浏览器自己播不了外域直播流（CORS + 协议支持都不够），所以统一由本地服务 spawn 一个桌面播放器。
 */
/** 浏览器原生支持 HLS 时（Safari）就地弹窗播，省得非要去开本机播放器 */
function playInModal(e, url) {
  openModal(
    t('在浏览器里播放 · {name}', { name: nameOf(e) }),
    [
      {
        type: 'html',
        html:
          `<div class="m-note">${t('你用的是<b>原生支持 HLS</b>的浏览器，直接在页面里播就行，不用唤起本机播放器。')}</div>` +
          `<video id="mv" controls autoplay playsinline style="width:100%;margin-top:8px;background:#000;border-radius:6px" src="${esc(url)}"></video>` +
          `<div class="m-note">${t('要是黑屏或一直转圈，多半是源站校验了 Referer / 只允许播放器 UA —— 这种得用本机播放器打开。')}</div>`,
      },
    ],
    () => {
      const v = $('#mv');
      if (v) v.pause();
    },
  );
  // 播不了（比如被源站拒了）就给个出口，别让人对着黑屏发呆
  const v = $('#mv');
  if (v) {
    v.addEventListener('error', () => {
      if (!state.player) return alert(t('这个地址浏览器播不了，且本机没配播放器（去「播放器设置」指一个 exe）'));
      openInPlayer(e);
    });
  }
}

/**
 * 「窗口被盖住」的出口。
 *
 * spawn 完会自己捞一次，但 Windows 的前台激活规则多半不放行（后台进程抢不了前台，
 * SetForegroundWindow 直接被拒），所以得留一条**用户亲手点一下**的路：
 * 人点了鼠标那一刻前台权限才真的松开，这一次才有戏。
 */
function showRaiseBar(msg) {
  const bar = $('#raiseBar');
  if (!bar || !state.player) return;
  // 这里千万别把变量取名 t：它会盖掉从 i18n.js import 进来的 t()，
  // 于是下一行「msg 为空」时那个 t('播放器窗口…') 就变成对 DOM 元素调函数，
  // 抛出来的是 t is not a function —— 播放器明明开起来了，界面却弹「打开失败」。
  const msgEl = $('#raiseMsg');
  if (msgEl) msgEl.textContent = msg || t('播放器窗口可能盖在浏览器后面：声音在放，画面看不见。');
  // 底部现在同时住着 toast 和这条浮层，别让「已用 VLC 打开」跟它叠在一起（同一位置、一上一下）
  hideToast();
  bar.hidden = false;
}

function hideRaiseBar() {
  const bar = $('#raiseBar');
  if (bar) bar.hidden = true;
}

$('#btnRaiseHide')?.addEventListener('click', hideRaiseBar);
$('#btnRaiseWin')?.addEventListener('click', async () => {
  try {
    const r = await fetch('/api/raise', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    toast(
      j.ok
        ? t('已把 {n} 个播放器窗口调到最前；还在后面就双击 VLC 托盘图标', { n: j.count || 0 })
        : t('没捞到窗口（播放器可能已经关了）'),
    );
  } catch (err) {
    toast(t('调窗口失败：{msg}', { msg: err.message }));
  }
  hideRaiseBar();
});

/**
 * 把一条流交给本机播放器。
 * @param {object} e 频道
 * @param {{step?:number, silent?:boolean}} [opts] step：第几个窗口（0 起，用来错开位置）；
 *        silent：失败只抛错不弹窗（批量开时好几条失败弹一堆窗没法点）
 */
async function openInPlayer(e, opts = {}) {
  const url = (e.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    if (opts.silent) throw new Error(t('「{name}」没有 http/https 流地址', { name: nameOf(e) }));
    return alert(t('「{name}」没有 http/https 流地址，播放器打不开', { name: nameOf(e) }));
  }
  if (BROWSER_HLS) return playInModal(e, url);
  if (!state.player) {
    if (opts.silent) throw new Error(t('本机没找到可用播放器'));
    return alert(t('本机没找到可用播放器，先点「播放器设置」指一个路径'));
  }
  try {
    const r = await fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, player: state.player, raise: opts.step || 0 }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    toast(t('已用「{player}」打开：{name}', { player: j.player || state.player.name, name: nameOf(e) }));
    showRaiseBar();
  } catch (err) {
    if (opts.silent) throw err;
    alert(t('打开失败：{msg}', { msg: err.message }));
  }
}

/**
 * 把选中的频道一次性排进**同一个**播放器窗口。
 *
 * 刻意不开多个窗口：几路声音同时出会糊成一团，体验很差。
 * 这里只发一个请求，服务端写一份临时播放清单交出去，播放器内部按列表轮流播 ——
 * 实际效果就是「一个 VLC 窗口里换台」。
 * @param {Array} list 频道
 */
async function openBatch(list) {
  const items = list
    .filter((e) => /^https?:\/\//i.test((e.url || '').trim()))
    .map((e) => ({ name: nameOf(e), url: e.url.trim() }));
  if (!items.length) return alert(t('这些频道没有 http/https 流地址'));
  if (!state.player) return alert(t('本机没找到可用播放器，先点「播放器设置」指一个路径'));
  // 清单排太长窗口里翻着累，超过 50 条先问一句（不是拦着不干）
  const cap = 50;
  const rest = items.length - cap;
  if (
      rest > 0
      && !confirm(
        t('会往同一个播放器窗口里排 {total} 条（只排前 {cap} 条，剩下的没进去），继续吗？', {
          total: items.length,
          cap,
        }),
      )
    )
    return;
  const batch = items.slice(0, cap);

  try {
    const r = await fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: batch, player: state.player }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    const n = j.count || batch.length;
    const who = j.player || state.player.name;
    toast(
      j.reused
        ? t('又往「{who}」那一个窗口里加了 {n} 条（现在 {n} 条排在一起，一次只出一路声）。', { who, n })
        : t('已用「{who}」打开 {n} 条，全在同一个窗口里排着；窗口里切一下就能换台（一次只出一路声）。', { who, n }),
    );
    setTimeout(
      () =>
        showRaiseBar(
          n > 1
            ? t(
                '这 {n} 条排在同一个播放器窗口里依次播（一次只出一路声）。若被浏览器盖住，点「调到最前」把它捞回来。',
                { n },
              )
            : t('若只听见声音、看不见画面，说明窗口被浏览器盖住了：点「调到最前」或双击播放器托盘图标。'),
        ),
      2200,
    );
  } catch (err) {
    alert(t('打开失败：{msg}', { msg: err.message }));
  }
}

$('#btnPlaySel').addEventListener('click', async () => {
  if (!state.entries.length) return alert(t('先载入播放列表'));
  const list = pickTargets();
  // Safari 那条路是页面内弹窗，一次塞一堆只会叠成一摞窗口，还是老老实实开一条
  if (BROWSER_HLS) {
    const first = list.find((e) => /^https?:\/\//i.test((e.url || '').trim())) || list[0];
    if (!first) return alert(t('这些频道没有流地址'));
    return void openInPlayer(first);
  }
  if (list.length > 1) return void openBatch(list);
  await openInPlayer(list[0]);
});

/**
 * 播放器设置 —— 不盲信系统默认关联：那玩意儿往往是浏览器，浏览器播不了直播流。
 * 这里列出扫到的播放器，也允许直接指一个 .exe/.app 路径，选完存起来下次不用重选。
 */
$('#btnPlayerCfg').addEventListener('click', () => {
  const opts = state.players.length
    ? state.players.map((p) => `<option value="${esc(p.path)}"${state.player && state.player.path === p.path ? ' selected' : ''}>${esc(p.name)}</option>`).join('')
    : `<option value="">${esc(t('（没扫到常用播放器，可以手动填路径）'))}</option>`;
  openModal(
    t('播放器设置'),
    [
      {
        type: 'html',
        html: `<div class="m-note">${esc(
          t('扫到 {n} 个可用播放器<span class="mono">（{names}）</span>。选一个作为默认，行内的 <b>▶</b> 与工具栏「▶ 用播放器打开」都会用它。', {
            n: state.players.length,
            names: state.players.map((p) => p.name).join('、') || t('无'),
          }),
        )}</div>`,
      },
      { type: 'html', html: `<div class="m-note">${t('只认 <b>http/https</b> 地址；播放器路径填错了会在打开时提示。')}</div>` },
      {
        type: 'text',
        key: 'path',
        label: t('播放器可执行文件路径（留空＝取消自定义，回到自动扫描）'),
        value: state.player ? state.player.path : '',
        placeholder: state.players[0]
          ? state.players[0].path
          : t('例如 C:\\Program Files\\VideoLAN\\VLC\\vlc.exe'),
      },
      {
        type: 'html',
        html:
          '<div class="m-note" style="margin-top:6px">' +
          `<button type="button" class="btn sm" id="playerBrowse">${esc(t('浏览…'))}</button>` +
          `<span class="m-sub"> ${esc(t(' 拿不到真实磁盘路径，「浏览」走的是本机服务（可切盘符、可直接敲路径）'))}</span>` +
          '</div>' +
          '<div id="playerBrowser" class="browser" style="display:none"></div>',
      },
      { type: 'html', html: `<div class="m-note" style="margin-top:6px"><select class="m-f" id="playerPickSel" style="width:100%">${opts}</select></div>` },
    ],
    async (v) => {
      // 别叫 path：那是浏览器内置的全局（目录浏览器要用 path.dirname），这里遮蔽了容易埋雷
      const pPath = (v.path || '').trim();
      // 下拉选了别的就按下拉走，手填路径优先
      const picked = pPath || $('#playerPickSel')?.value || '';
      const r = await fetch('/api/players', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: picked }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return alert(t('保存播放器设置失败：{msg}', { msg: j.error || r.status }));
      // 主存是服务端的 ~/.iptv-playlist-master.json；localStorage 再留一份兜底，
      // 万一那台机器开了只读策略写不进去，刷新后也别把已选的播放器弄丢。
      try {
        localStorage.setItem('mpm.playerPath', picked || '');
      } catch {}
      setPlayers(j.players || [], (j.players || [])[0] || null);
      toast(
        state.player ? t('已选择播放器：{name}', { name: state.player.name }) : t('已回到自动扫描'),
      );
    },
  );
  // 弹窗里的下拉选了之后，把值同步到上面的路径输入框，免得两个地方对不上
  const sel = $('#playerPickSel');
  const inp = () => document.querySelector('#modalFields input[data-k="path"]');
  if (sel) sel.addEventListener('change', () => { const i = inp(); if (i && !i.value) i.value = sel.value; });
  // 「浏览…」由本机服务列目录（浏览器给不出 exe 的真实路径），选中的直接填进路径框
  $('#playerBrowser').innerHTML = '';
  $('#playerBrowser').style.display = 'none';
  const browse = $('#playerBrowse');
  if (browse) browse.addEventListener('click', () => openDirBrowser());
});

/** 盘符列表拿一次就够（每次列目录都带回来，只有出错时才可能还是空的） */
let browDrives = [];

/** 记住上次逛到哪个目录：装在别的盘的人不该每次都从 C 盘重头找 */
const browLast = () => {
  try {
    return localStorage.getItem('mpm.browseDir') || '';
  } catch {
    return '';
  }
};
const browSave = (d) => {
  try {
    if (d) localStorage.setItem('mpm.browseDir', d);
  } catch {
    /* 无痕模式 / 隐私设置不让写，忘了就忘了，不影响用 */
  }
};

/** 只读目录浏览器：切盘符 / 进目录 / 填路径直达 / 挑一个可执行文件 */
async function openDirBrowser() {
  const box = $('#playerBrowser');
  if (!box) return;
  box.style.display = '';

  // 到盘符根「上一级」就失效了（C:\ 的父目录还是 C:\），所以盘符要单独做成一排按钮，
  // 另外再给一个可直接敲路径的输入框 —— 这两个才是跨盘移动的正路。
  const chipRow = (cur) =>
    browDrives.length
      ? `<div class="browdrives">${browDrives
          .map((d) => {
            const raw = String(d);
            const label = raw.replace(/[\\/]+$/, '');
            const on = cur && cur.toLowerCase().startsWith(label.toLowerCase()) ? ' on' : '';
            return `<button type="button" class="browdrive${on}" data-go="${esc(d)}" title="${esc(raw)}">${esc(label)}</button>`;
          })
          .join('')}</div>`
      : '';

  const goRow = (ph) =>
    '<div class="browgo">' +
    `<input id="browPath" class="m-f" type="text" placeholder="${esc(ph)}" spellcheck="false">` +
    `<button type="button" class="btn sm" id="browGo">${esc(t('前往'))}</button>` +
    '</div>';

  const bindBar = () => {
    box.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => load(el.dataset.go)));
    box.querySelectorAll('[data-up]').forEach((el) => el.addEventListener('click', () => load(el.dataset.up)));
    const input = $('#browPath');
    const go = () => {
      const v = input.value.trim();
      if (v) load(v);
    };
    if (input) input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });
    const g = $('#browGo');
    if (g) g.addEventListener('click', go);
  };

  const load = async (dir) => {
    let j = null;
    try {
      const r = await fetch('/api/browse' + (dir ? '?dir=' + encodeURIComponent(dir) : ''));
      j = await r.json().catch(() => null);
    } catch {
      j = null;
    }
    // 服务端会把真实原因（路径不存在 / 没权限）写在 error 里，别换成含糊的套话
    if (!j || !j.ok) {
      const why = j && j.error ? j.error : t('读不了这个目录（不存在或没权限）');
      const parent = typeof dir === 'string' && dir ? path.dirname(dir) : '';
      box.innerHTML =
        `<div class="browtop"><span class="mono">${esc(why)}</span>` +
        (parent && parent !== dir
          ? `<button type="button" class="btn sm" data-up="${esc(parent)}">${esc(t('↑ 上一级'))}</button>`
          : '') +
        '</div>' +
        chipRow(undefined) +
        goRow(t('填一个目录路径后回车，例如 D:\\Software\\VideoLAN')) +
        `<div class="m-note">${esc(t('也可以直接手填路径，留空点「确定」＝回到自动扫描。'))}</div>`;
      bindBar();
      return;
    }
    if (Array.isArray(j.drives)) browDrives = j.drives;
    browSave(j.dir);

    const rows = j.entries
      .map((it) =>
        it.type === 'dir'
          ? `<div class="brow" data-dir="${esc(it.path)}">▸ 📁 ${esc(it.name)}</div>`
          : it.type === 'exe'
            ? `<div class="brow pick" data-file="${esc(it.path)}">▶ ${esc(it.name)}</div>`
            : '',
      )
      .join('');
    box.innerHTML =
      `<div class="browtop"><span class="mono" title="${esc(j.dir)}">${esc(j.dir)}</span>` +
      (j.parent && j.parent !== j.dir
        ? `<button type="button" class="btn sm" data-up="${esc(j.parent)}">${esc(t('↑ 上一级'))}</button>`
        : '') +
      '</div>' +
      chipRow(j.dir) +
      goRow(t('填一个目录路径后回车，例如 D:\\Software\\VideoLAN')) +
      (rows || `<div class="m-note">${esc(t('（这个目录里没有可执行程序）'))}</div>`);
    box.querySelectorAll('[data-dir]').forEach((el) => el.addEventListener('click', () => load(el.dataset.dir)));
    box.querySelectorAll('[data-file]').forEach((el) =>
      el.addEventListener('click', () => {
        const i = document.querySelector('#modalFields input[data-k="path"]');
        if (i) i.value = el.dataset.file;
        box.innerHTML = '';
        box.style.display = 'none';
      }),
    );
    bindBar();
  };

  // 起点：上次逛的目录 → 当前路径框里那条 exe 所在的目录 → 服务端默认（用户目录）
  let start = browLast();
  if (!start) {
    const i = document.querySelector('#modalFields input[data-k="path"]');
    if (i) start = i.value.trim();
  }
  await load(start);
}

/** 收到播放器清单后统一处理：记住选中项、切换行内 ▶ 的显示 */
function setPlayers(list, chosen) {
  state.players = list || [];
  state.player = chosen || list[0] || null;
  $('#btnPlaySel').classList.toggle('hidden', !state.player);
  if (typeof render === 'function') render();
}

// 启动时先问一次本机装了啥，有就常驻显示 ▶
(async function loadPlayers() {
  try {
    const r = await fetch('/api/players');
    const j = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray(j.players)) {
      // 上次选的优先（localStorage 兜底，服务端那份已经在 players[0] 里了），
      // 只有本地记的和服务端对不上时才退回第一个
      let wanted = '';
      try {
        wanted = localStorage.getItem('mpm.playerPath') || '';
      } catch {}
      const matched = wanted ? j.players.find((p) => p.path === wanted) : null;
      setPlayers(j.players, matched || j.players[0] || null);
    }
  } catch {} // 服务还没起来也别弹窗挡路
})();

$('#btnDelSel').addEventListener('click', () => {
  if (!state.selected.size) return alert(t('没有选中任何频道'));
  if (!confirm(t('确定删除 {n} 个频道？', { n: state.selected.size }))) return;
  state.entries = state.entries.filter((e) => !state.selected.has(e.id));
  state.selected.clear();
  refreshGroupOptions();
  render();
});

$('#btnBatchGroup').addEventListener('click', () => {
  if (!state.selected.size) return alert(t('先选中要改的频道'));
  openModal(
    t('批量改分组'),
    [
      {
        key: 'group',
        label: t('改为分组'),
        value: visible().find((e) => state.selected.has(e.id)) ? grpOf(visible().find((e) => state.selected.has(e.id))) : '',
        placeholder: t('例如：央视'),
        datalist: groupChoices(),
      },
    ],
    (vals) => {
      state.entries.filter((e) => state.selected.has(e.id)).forEach((e) => setAttr(e, 'group-title', vals.group));
      refreshGroupOptions();
      render();
    },
  );
});

/**
 * 从源站更新 —— 让「Updater」这一半名副其实。
 *
 * 源站列表每天在变（换源、改 LOGO、加频道、踢死链）。这里不去覆盖本地这张表，
 * 而是把远端最新内容「合并」进来：手动改过的地址/频道名一律保留，
 * 只让远端去补本地没有或还旧的部分。
 */
function openUpdateModal(url) {
  const cur = state.entries;
  openModal(
    t('从源站更新列表'),
    [
      { type: 'html', html: `${t(
        '将拉取 <span class="mono">{url}</span> 的最新列表，与当前 {n} 条合并。<br>本地手动改过的地址 / 频道名不会被源站覆盖。',
        { url: esc(url), n: cur.length },
      )}</div>` },
      { type: 'check', key: 'append', label: t('追加远端新增的频道（不勾的话只更新已有的）'), value: true },
      { type: 'check', key: 'prune', label: t('删除远端已经移除的频道（不勾则本地保留，勾之前先导出一份）'), value: false },
    ],
    async (v) => {
      // 拉取期间别把弹窗关掉，否则界面上一点动静都没有，像是点了没反应
      $('#modal').classList.remove('hidden');
      const btn = $('#modalOk');
      btn.disabled = true;
      btn.textContent = t('拉取中…');
      let j = {};
      try {
        const r = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`);
        j = await r.json().catch(() => ({}));
        if (!r.ok || !j.b64) throw new Error(j.error || `HTTP ${r.status}`);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = t('确定');
        alert(t('拉取源站失败：{msg}', { msg: e.message || e }));
        return;
      }
      btn.disabled = false;
      btn.textContent = '确定';

      const incoming = parseM3U(decodeBuffer(b64ToBytes(j.b64)));
      const { entries, stats } = mergePlaylist(cur, incoming.entries, {
        append: !!v.append,
        prune: !!v.prune,
      });

      if (!stats.updated && !stats.added && !stats.pruned) {
        toast(t('源站内容与本地一致，没有可更新的'));
        return;
      }
      adopt(
        { ...state.doc, entries },
        { path: state.path, srcName: state.srcName, encoding: state.encoding },
      );
      registerWithServer();
      const parts = [t('{n} 条换用新源', { n: stats.updated }), t('新增 {n} 条', { n: stats.added })];
      if (stats.pruned) parts.push(t('删除 {n} 条', { n: stats.pruned }));
      if (stats.blocked) parts.push(t('{n} 条因本地手改而保留', { n: stats.blocked }));
      toast(t('已更新：{parts}', { parts: parts.join(' / ') }));
    },
  );
}

$('#btnUpdate').addEventListener('click', () => {
  if (!state.entries.length) return alert(t('先载入播放列表'));
  const url = prompt(
    t('填入源站（播放列表）地址：\n（本地这张已编辑过的表不会被覆盖，只做合并）'),
    state.srcUrl || '',
  );
  if (!url || !url.trim()) return;
  state.srcUrl = url.trim();
  try {
    localStorage.setItem('mpm.srcUrl', state.srcUrl);
  } catch {}
  openUpdateModal(state.srcUrl);
});

/** 探测结果里能当后缀用的档位："1920x1080 (1080p)" -> "1080p" */
const tierOf = (e) => {
  const p = e.probe;
  const m = p && p.ok && p.format ? /\(([^)]+)\)/.exec(p.format) : null;
  return m && m[1] ? m[1] : '';
};

/** 「没选中」就等于「全表」，这一行在几个批量操作里反复用到 */
const pickTargets = () =>
  state.selected.size
    ? state.entries.filter((e) => state.selected.has(e.id))
    : state.entries;

/**
 * 回填分辨率 —— 和「回填延迟」一样，只负责写分辨率后缀：
 * 有探测值就追加/更新（名字里写 1080p 实测 480p 的会被纠正），
 * 没探测值的一个字都不动，绝不静默删掉用户手写的后缀。
 */
$('#btnFillRes').addEventListener('click', () => {
  if (!state.entries.length) return alert(t('先载入播放列表'));
  const targets = pickTargets();
  const usable = targets.filter((e) => tierOf(e));

  openModal(
    t('回填分辨率到频道名'),
    [
      {
        type: 'check',
        key: 'strip',
        label: t('已有的手写分辨率后缀先用探测值覆盖（名字写 1080p、实测 480p 的会被纠正）'),
        value: true,
      },
      {
        type: 'check',
        key: 'keepNoProbe',
        label: t('没探测到分辨率的频道保持原样（当前 {n} 条，不会动它们）', {
          n: targets.length - usable.length,
        }),
        value: true,
      },
    ],
    (vals) => {
      if (!usable.length) {
        alert(
          t(
            '这些频道都没有探测出分辨率，没有可回填的值，频道名一个字都不会改。\n（先跑一遍探测，或换个能返回 HLS 主清单的源）',
          ),
        );
        return;
      }
      let n = 0;
      for (const e of usable) {
        const next = rebuildResName({
          title: e.title,
          tier: tierOf(e),
          strip: !!vals.strip,
          append: true,
          force: false,
        });
        if (next !== e.title) {
          e.title = next;
          n++;
        }
      }
      state.doc.dirty = true;
      refreshGroupOptions();
      render();
      alert(
        n
          ? t('已回填 {n} 条频道名的分辨率后缀（另有 {rest} 条已是最新，无需改动）', {
              n,
              rest: usable.length - n,
            })
          : t('分辨率后缀已经是最新，无需改动'),
      );
    },
  );
});

/**
 * 彻底清洗频道名 —— 只做减法：分辨率后缀和延迟后缀全部摘掉，一个字都不回填。
 * 只有「压根不想在频道名后面看到这些」的时候才点这个（点之前会再确认一次）。
 */
$('#btnCleanName').addEventListener('click', () => {
  if (!state.entries.length) return alert(t('先载入播放列表'));
  const targets = pickTargets();

  openModal(
    t('彻底清洗频道名后缀'),
    [
      { type: 'check', key: 'res', label: t('去掉末尾分辨率后缀（480p / 1080i / 4K …）'), value: true },
      { type: 'check', key: 'delay', label: t('去掉末尾延迟后缀（1043ms / 延迟135ms / [317ms] …）'), value: true },
    ],
    (vals) => {
      let n = 0;
      for (const e of targets) {
        let name = vals.delay ? stripDelaySuffix(e.title) : String(e.title || '');
        if (vals.res) name = stripResSuffix(name);
        name = name.replace(/[\s·\-–—,，、]+$/, '').trim();
        if (name !== e.title) {
          e.title = name;
          n++;
        }
      }
      if (!n) {
        render();
        alert(t('这些频道名上没有可清掉的后缀'));
        return;
      }
      const ok = confirm(
        t(
          '即将清掉 {n} 条频道名末尾的后缀，且不会再补回探测值。\n（如果只是想把探测结果写进名字，请用「回填分辨率 / 回填延迟」）\n继续？',
          { n },
        ),
      );
      if (!ok) return;
      state.doc.dirty = true;
      refreshGroupOptions();
      render();
      alert(t('已清掉 {n} 条频道名的后缀，导出后再保存', { n }));
    },
  );
});

/**
 * 延迟回填：把探测到的首字节延迟（ttfbMs）写进频道名末尾。
 * 同一频道往往有几十条源，名字一样的时候光看列表分不出好坏，
 * 把延迟摆在名字里，在 IPTV 软件里就能直接挑低的那个。
 */
$('#btnFillDelay').addEventListener('click', () => {
  if (!state.entries.length) return alert(t('先载入播放列表'));
  const targets = state.selected.size
    ? state.entries.filter((e) => state.selected.has(e.id))
    : state.entries;
  const withDelay = targets.filter((e) => e.probe && e.probe.ok && e.probe.ttfbMs).length;

  openModal(
    t('回填延迟到频道名'),
    [
      { type: 'check', key: 'strip', label: t('去掉末尾已有的延迟后缀（1043ms / 延迟135ms / [317ms]）'), value: true },
      { type: 'check', key: 'fill', label: t('把探测到的延迟写成后缀（当前 {n} 条有可用延迟）', {
        n: withDelay,
      }), value: true },
      { key: 'tpl', label: t('后缀模板（{ms} 换成毫秒数）'), value: '{ms}ms', placeholder: '{ms}ms' },
      { type: 'check', key: 'markBad', label: t('没测出延迟的也标出来，挑的时候一眼排掉'), value: false },
      { key: 'badTpl', label: t('标记文字'), value: t('超时'), placeholder: t('超时') },
    ],
    (vals) => {
      let n = 0;
      for (const e of targets) {
        const p = e.probe;
        const usable = p && p.ok && p.ttfbMs;
        // ms 为空（没测出来）时 append 关掉，只做清理；没勾 fill 就纯摘后缀
        const next = rebuildName({
          title: e.title,
          ms: usable ? p.ttfbMs : 0,
          tpl: vals.fill ? vals.tpl : '',
          strip: !!vals.strip,
          append: vals.fill ? true : false,
        });
        const marked = vals.markBad && !usable && vals.badTpl;
        const name = marked ? `${next} ${vals.badTpl}` : next;
        if (name !== e.title) {
          e.title = name;
          n++;
        }
      }
      state.doc.dirty = true;
      refreshGroupOptions();
      render();
      alert(
        n ? t('已更新 {n} 条频道名，导出后再保存', { n }) : t('没有需要改的频道名'),
      );
    },
  );
});

/**
 * 同名频道按延迟排序 —— 和「回填延迟」分开的两件事：
 * 回填改的是**名字**，排序挪的是**位置**；不想让名字变脏就只点这个。
 */
$('#btnSortDelay').addEventListener('click', () => {
  if (!state.entries.length) return alert(t('先载入播放列表'));
  const before = state.entries.slice();
  const after = sortSameNameByDelay(before);
  const moved = movedCount(before, after);
  if (!moved) {
    alert(t('同名频道已经是按延迟排好的（没有需要挪位置的）'));
    return;
  }
  state.entries = after;
  state.doc.dirty = true;
  render();
  // 排序只改内存里的数组顺序，导出/保存都会带上；但如果随后又载入别的列表就没了
  alert(
    t('已在同名频道组内按延迟重排，{n} 条的排列顺序有变化。导出或保存时会带上这个顺序。', { n: moved }),
  );
});

$('#btnAdd').addEventListener('click', () => openEntryModal(null));

$('#btnOpen').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let b64 = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const name = f.name;
  $('#srcLabel').textContent = t('读取 {name} …', { name });
  loadPayload({ b64: btoa(b64), name }).then(() => ($('#fileInput').value = ''));
});

$('#btnUrl').addEventListener('click', () => {
  const url = prompt(t('填入远程播放列表地址（由本地服务代取，可绕开跨域）：'));
  if (!url) return;
  loadPayloadFromApi(`/api/fetch?url=${encodeURIComponent(url)}`, url);
});

$('#btnReadPath').addEventListener('click', () => {
  const p = $('#pathInput').value.trim();
  if (!p) return alert(t('填入绝对路径，例如 D:\\playlist\\channels.m3u'));
  loadPayloadFromApi('/api/read', null, p);
});

async function loadPayloadFromApi(api, name, absPath) {
  const srcName = name || null;
  $('#srcLabel').textContent = t('载入中…');
  const r = await fetch(api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: absPath || null }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    alert(t('载入失败：{msg}', { msg: j.error || r.status }));
    $('#srcLabel').textContent = t('载入失败');
    return;
  }
  if (!j.b64) return alert(t('服务端没有返回列表内容'));

  // 和粘贴/选文件走同一条解析路径，整个应用只有一处 parseM3U
  adopt(parseM3U(decodeBuffer(b64ToBytes(j.b64))), {
    path: j.path || null,
    srcName: srcName || j.name || absPath || t('远程列表'),
    encoding: j.encoding || 'utf-8',
  });
  registerWithServer();
}

$('#btnPaste').addEventListener('click', () => {
  // 同样别叫 t：下面紧接着的 t('先把 m3u 文本粘进去') 是对翻译函数取值，
  // 被同名局部变量盖住就会在字符串上调函数，整段导入逻辑直接哑火。
  const txt = $('#paste').value;
  if (!txt.trim()) return alert(t('先把 m3u 文本粘进去'));
  loadPayload({ text: txt, name: t('粘贴内容') });
});

/* ---------------- 拖拽导入 ---------------- */

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  $('#dropMask').classList.add('on');
});
// 只认「拖文件进来」：拖表格行也会一路冒 dragleave，不这么挡会把导入蒙层抖出来
window.addEventListener('dragleave', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('#dropMask').classList.remove('on');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropMask').classList.remove('on');
  const f = e.dataTransfer.files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let b64 = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  loadPayload({ b64: btoa(b64), name: f.name });
});

/* ---------------- 探测 ---------------- */

$('#btnProbe').addEventListener('click', () => {
  const list = visible();
  if (!list.length) return;
  if (
    !confirm(
      t('对当前 {n} 个频道发起探测？\n每条约 8 秒超时、瞬时失败自动重试（最多共 3 次）、403 会换播放器 UA 再试、同源最小间隔 0.2 秒。', {
        n: list.length,
      }),
    )
  )
    return;
  probe(list.map((e) => e.id));
});

/**
 * 补测收尾的汇总：这一趟挖到几条、剩下几条都卡在什么上。
 *
 * 有了这一行数字，「4MB 到底兜不兜得住」就不用自己翻表数了 ——
 * 剩下那几条是什么类型一目了然：全挂在「关键帧太远」上说明窗口还得再大，
 * 一堆「纯音频」说明这批本来就不该挖，不该算在窗口的账上。
 */
function retryResSummary(attempted) {
  const left = state.entries.filter((e) => e.probe && e.probe.ok && !e.probe.format);
  const got = state.entries.filter((e) => e.probe && e.probe.ok && e.probe.format).length;
  const by = new Map();
  for (const e of left) {
    const key = e.probe.noRes || 'other';
    by.set(key, (by.get(key) || 0) + 1);
  }
  const parts = [...by.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${NO_RES_LABEL[k] || k} ${n} 条`)
    .join(' · ');
  return t('补测完这 {n} 条：挖到分辨率 {got} 条，仍没读到 {rest} 条（{parts}）', {
    n: attempted,
    got,
    rest: left.length,
    parts: parts || '—',
  });
}

/**
 * 局部重挖：只对这几条「明明能播、却没读到分辨率」的条目，用大得多的窗口再挖一次。
 *
 * 为什么不直接把批量探测的窗口改大：批量探测读 64KB 就收手，是摊给整张表的流量预算；
 * 这里只有「有价值」的那几条破例（见 RES_RETRYABLE），按钮也就只长在它们身上 ——
 * 挖不到也是有用的结论：那说明不是窗口不够，是这条流压根没东西可挖。
 *
 * @param {Array} entries 要补测的条目
 * @param {{batch?:boolean}} [opts] batch = 从工具栏批量发起（先确认一次）
 */
function retryRes(entries, { batch = false } = {}) {
  const list = entries.filter((e) => e.probe && e.probe.ok && !e.probe.format);
  if (!list.length) return;
  if (batch) {
    const n = list.length;
    if (
      !confirm(
        t('把这 {n} 条逐个用更大的窗口重读一遍？\n每条最多往下读 {mb}MB、独立超时 25 秒；挖到关键帧就补上分辨率，挖不到也照实记在表里，方便对照着判断窗口该不该再加大。', {
          n,
          mb: DEEP_PROBE_BYTES / 1048576,
        }),
      )
    )
      return;
  }
  const before = resRetryList().length;
  // 先把这几行的 ⟳ 换成转圈，别让探测在跑的时候还挂着按钮让人连点
  for (const e of list) {
    const td = document.querySelector(`#tbody tr[data-id="${e.id}"] [data-c="res"]`);
    if (td) td.innerHTML = resBusyCell();
  }
  probe(list.map((e) => e.id), {
    bytes: DEEP_PROBE_BYTES,
    timeout: 25000,
    doneMsg: retryResSummary(before),
  });
}

$('#btnRetryRes').addEventListener('click', () => retryRes(resRetryList(), { batch: true }));

/**
 * 进度面板的三个收尾动作。
 *
 * 面板是贴在常驻工具栏下面那条（在 <main> 这个滚动容器外面），列表怎么滚它都在，
 * 跑完好把它收起来就行 —— 早先它长在 main 里，一滚就看不见，等于没有。
 * 「待收起」的定时器故意挂在面板自己身上（box._hideTimer），
 * 这样 stopProbeUI 掐另一趟探测时能顺手把它清掉，
 * 免得新探测定时器还没到点、上一趟那条先把别人刚拉起来的面板收了。
 */

/** 把「跑完、等会儿自己收起」这一档取消掉（面板的隐藏状态一点不动） */
function cancelProgressTuck() {
  const box = $('#progress');
  clearTimeout(box._hideTimer);
  box._hideTimer = null;
  if (box.classList) box.classList.remove('tucked');
}

/** 立即收起：面板藏起来、进度归零、淡出标记抹平（点停止、连接出错时走这条） */
function closeProgressBar() {
  const box = $('#progress');
  cancelProgressTuck();
  box.classList.add('hidden');
  $('#bar').style.width = '0%';
}

/**
 * 跑完了：先停在 100% 让人看清「确实跑完了」，再加 PROGRESS_HOLD_MS 收起。
 * 顺手叠一层 .tucked 淡一拍，收得很轻，不会吓人一跳。
 */
function holdProgressBar() {
  const box = $('#progress');
  clearTimeout(box._hideTimer);
  box.classList.add('tucked');
  box._hideTimer = setTimeout(() => {
    box._hideTimer = null;
    box.classList.remove('tucked');
    box.classList.add('hidden');
    $('#bar').style.width = '0%';
  }, PROGRESS_HOLD_MS);
}

/**
 * @param {string[]} ids
 * @param {{bytes?:number, timeout?:number, quiet?:boolean, doneMsg?:string}} [opts]
 *   bytes   这一批每条愿意收多少字节（局部重挖就传 DEEP_PROBE_BYTES 顶到 4MB）
 *   quiet   别把「成功 N 条 / 失败 M 条」那句总结弹出来（单条重挖自己说话）
 *   doneMsg 补测跑完时的汇总，由调用方给（单条重挖这边不说）
 */
function probe(ids, opts = {}) {
  const { bytes = 0, timeout = 8000, quiet = false, doneMsg = '' } = opts;
  // 新的一趟接手前先把上一趟收干净（顺手把进度面板重新露出来，下面会重设它）
  stopProbeUI();
  const box = $('#progress');
  const bar = $('#bar');
  const txt = $('#progressTxt');
  box.classList.remove('hidden');
  bar.style.width = '0%';
  txt.textContent = t('连接中…');

  const q = `concurrency=${bytes ? 1 : 8}&timeout=${timeout}${bytes ? `&bytes=${bytes}` : ''}`;
  const es = new EventSource(`/api/probe?ids=${ids.join(',')}&${q}`);
  activeEs = es;
  let total = ids.length;

  es.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'start') {
      total = m.total;
      return;
    }
    if (m.type === 'result') {
      const e = state.entries.find((x) => x.id === m.row.id);
      if (e) {
        e.probe = m.row;
        updateRow(e);
      }
      bar.style.width = `${Math.round((m.done / total) * 100)}%`;
      txt.textContent = t('已测 {done} / {total}', { done: m.done, total });
      return;
    }
    if (m.type === 'done') {
      es.close();
      if (activeEs === es) activeEs = null;
      // 跑完了：进度条在 100% 上留一下再自己收起（点「停止」或开新一趟会立刻替它收）
      bar.style.width = '100%';
      holdProgressBar();

      // 探测失败的自动选中：之前只在这里说了句「已自动选中」，其实压根没改过 selection，
      // 提示语是一句空承诺。现在真的把它们勾上，并如实报「新增了几条」。
      let added = 0;
      for (const e of state.entries) {
        if (e.probe && !e.probe.ok && !state.selected.has(e.id)) {
          state.selected.add(e.id);
          added++;
        }
      }
      refreshGroupOptions();
      // 只刷选中态，不重建整表 —— 探测刚跑完，重建会让页面跳动、输入框失焦
      syncSelectionUI();

      // 有条目在线但没读到分辨率，却一条原因都没回报 —— 多半是服务还跑着旧版本，
      // 这层得点破，否则用户看到的只是一排没有任何线索的「—」。
      const extra = noResBlindNote();
      const bad = state.entries.filter((x) => x.probe && !x.probe.ok).length;
      // 补测这一趟：本来就没有「失败」，别去报「已勾选」那套；
      // 汇总交给调用方给的 doneMsg，同时把工具栏的补测按钮重算一遍。
      syncResRetryBtn();
      if (doneMsg) {
        toast(doneMsg);
        return;
      }
      const noget = total - bad;
      const msg =
        t('探测完成：{total} 条，失败 {bad} 条（已勾上，其中新增 {added} 条）', {
          total,
          bad,
          added,
        }) + (noget ? `\n${t('其中 {n} 条在线', { n: noget })}` : '') + (extra ? `\n${extra}` : '');
      if (bad) alert(msg);
      else toast(msg);
    }
  };
  es.onerror = () => {
    es.close();
    if (activeEs === es) activeEs = null;
    // 连接断了（服务重启之类）就没必要留着进度条淡等了，直接收
    closeProgressBar();
  };
}

/**
 * 掐断正在跑的探测，并把进度面板收拾干净。
 *
 * 光 `es.close()` 是不够的：关掉连接服务端确实会停队列，但界面上会留一条停在
 * 「已测 73 / 300」的进度条 —— 看着像还在跑，实际早空了。所以这边一并收尾：
 * 面板整个藏起来、进度条归零、文字清空；补测那几行还挂着 ⌛ 的（转圈再也转不回来），
 * 按各自的探测结果还原成 ⟳ 或「—」，别留一排永远在转的圈。
 *
 * 挂在面板上的「跑完自己收起」定时器（跑完那 1.4 秒里）会在这里被提前掐掉 ——
 * 也就是点「停止」时面板立刻收，不等那 1.4 秒走完。这段跟「有没有真在跑」无关，
 * 所以放在 return 之前；没在跑时面板的显示状态一点不动（幂等）。
 *
 * @returns {boolean} 刚才是不是真有一趟在跑（没跑就什么都不碰）
 */
function stopProbeUI() {
  const running = activeEs;
  activeEs = null;
  // 上一趟若是「跑完、正排着收起」，先把那条挂起的定时器掐掉再自己收（顺手就算停止了）；
  // 面板在这里不做收尾 —— 没在跑的时候别去动它的显示状态。
  cancelProgressTuck();
  if (!running) return false;
  try {
    running.close();
  } catch {}
  closeProgressBar();
  $('#progressTxt').textContent = '';
  for (const td of document.querySelectorAll('#tbody tr[data-id] [data-c="res"]')) {
    if (!td.classList || !td.classList.contains('resbusy')) continue;
    const tr = td.closest ? td.closest('tr') : null;
    const e = tr && state.entries.find((x) => x.id === tr.dataset.id);
    td.innerHTML = resCell(e && e.probe);
  }
  return true;
}

$('#btnStopProbe').addEventListener('click', stopProbeUI);

/* ---------------- 保存 / 导出 ---------------- */

// 必须把 doc 的其余部分整体透传（header / comments / tailComments / eol / trailingNewline），
// 只挑 header + entries 会丢掉文件头注释、CRLF 行尾、末尾换行——那恰好就是本项目
// 要避免的「编辑一轮保存，厂商给的私有属性全没了」。
// 而 state.entries 是实时数组（删频道时会被整个替换），所以 entries 单独取最新的。
const serialize = () => serializeM3U({ ...state.doc, entries: state.entries });

function download(filename, text) {
  // 导出成 .m3u8 时去 BOM：RFC 8216 要求 m3u8 正文不带 BOM（带了的播放器可以拒收）。
  // .m3u 没这条规矩，源文件带着 BOM 就照原样给回去，覆盖保存那条路同理。
  const hls8 = isM3U8Name(filename);
  const body = hls8 ? stripBom(text) : text;
  // .m3u 用 Winamp 那边的老 MIME，.m3u8 才是 Safari / iOS 原生 <video> 认的那一套
  const mime = hls8 ? 'application/vnd.apple.mpegurl' : 'audio/x-mpegURL';
  const blob = new Blob([body], { type: `${mime};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const baseName = () => (state.srcName.replace(/\.(m3u8?|txt)$/i, '') || 'playlist') + '-edited';

$('#btnExportM3U').addEventListener('click', () => download(baseName() + '.m3u', serialize()));
$('#btnExportM3U8').addEventListener('click', () => download(baseName() + '.m3u8', serialize()));

$('#btnSave').addEventListener('click', async () => {
  if (!state.path) return;
  if (!confirm(t('覆盖写回原文件：\n{path}\n\n建议先导出一份副本。', { path: state.path }))) return;
  const r = await fetch('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: state.path, text: serialize() }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) return alert(t('保存失败：{msg}', { msg: j.error || r.status }));
  alert(t('已覆盖保存。'));
});

/* ---------------- 弹窗 ---------------- */

let modalOk = null;
function openModal(title, fields, onOk) {
  $('#modalTitle').textContent = title;
  $('#modalFields').innerHTML = fields
    .map(
      (f) =>
        // 纯展示块（比如 LOGO 预览图），不进表单值收集
        f.type === 'html'
          ? `<div class="m-html">${f.html}</div>`
          : f.type === 'check'
            ? `<label class="chk"><input type="checkbox" class="m-f" data-k="${esc(f.key)}"${f.value ? ' checked' : ''}> ${esc(f.label)}</label>`
            // 可输入的组合框（input + datalist）：候选只负责补全，输入框没有任何「被选中就不让打字」的限制。
            // 比「单选框 / 输入框」二选一的互斥方案轻得多 —— 手打照旧自由，点选也只是填入。
            : f.datalist
              ? `<label>${esc(f.label)}
      <input class="m-f" data-k="${esc(f.key)}" type="text" list="${esc(f.listId || 'mpm-dl-' + f.key)}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}">
      <datalist id="${esc(f.listId || 'mpm-dl-' + f.key)}">${f.datalist.map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist>
    </label>`
              : `<label>${esc(f.label)}
      <${f.type === 'textarea' ? 'textarea' : 'input'} class="m-f" data-k="${esc(f.key)}"
        type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}">${f.type === 'textarea' ? esc(f.value ?? '') : ''}</${f.type === 'textarea' ? 'textarea' : 'input'}>
    </label>`,
    )
    .join('');
  modalOk = onOk;
  $('#modal').classList.remove('hidden');
  const first = $(`#modalFields .m-f[data-k="${esc(fields[0]?.key ?? '')}"]`) || $('#modalFields .m-f');
  if (first) first.focus();
}
$('#modalCancel').addEventListener('click', () => $('#modal').classList.add('hidden'));
$('#modal').addEventListener('click', (e) => {
  if (e.target === $('#modal')) $('#modal').classList.add('hidden');
});
$('#modalOk').addEventListener('click', () => {
  const vals = {};
  document.querySelectorAll('#modalFields .m-f').forEach((el) => {
    // 复选框要读 checked，读 value 的话勾不勾都是 "true"
    vals[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value;
  });
  const fn = modalOk;
  modalOk = null;
  $('#modal').classList.add('hidden');
  if (fn) fn(vals);
});
$('#modal').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') $('#modalOk').click();
});

/**
 * 补 LOGO —— 只有没 LOGO（或图挂了）的行才会出现这个 [+]。
 * 带一个实时预览，填完能立刻看出这个地址在浏览器里到底能不能开，
 * 免得存进去一串播放器加载不出来的死链。
 */
function openLogoModal(e) {
  openModal(
    t('补 LOGO 地址'),
    [
      { key: 'url', label: t('LOGO 图片地址（填好后回车即写入 tvg-logo；留空表示去掉 LOGO）'), value: logoOf(e), placeholder: 'https://…/logo.png' },
      { type: 'html', html: `<div class="logo-prev"><img id="logoPrev" alt="${esc(t('预览'))}" hidden></div>` },
    ],
    (v) => {
      const url = String(v.url || '').trim();
      setLogo(e, url);
      state.doc.dirty = true;
      refreshLogoCell(e, !url);
      refreshGroupOptions();
      toast(url ? t('已写入 tvg-logo，导出后再保存') : t('已去掉这个频道的 LOGO'));
    },
  );
  const inp = $('#modalFields input[data-k="url"]');
  const prev = document.getElementById('logoPrev');
  const sync = () => {
    const v = inp.value.trim();
    if (v) {
      prev.src = v;
      prev.hidden = false;
    } else {
      prev.removeAttribute('src');
      prev.hidden = true;
    }
  };
  inp.addEventListener('input', sync);
  sync();
}

/**
 * 「添加新频道」时用流内 SDT 服务名当默认频道名的判定。
 *
 * 探测回来一整坨，能拿来做默认名的只有 serviceName 这一个字段，
 * 别的（分辨率、延迟、吞吐）跟名字没关系，别往这块凑。
 *
 * 服务名**长短差得远**（实测见过 dftvHD 这种短名，也见过
 * 「Phoenix Satellite Television Co Ltd HD Phx Chinese Channel .z0」一整句），
 * 所以这里只负责「原样取出来」，一概不清洗、不截断 —— 想改让用户自己改。
 * 程序替用户裁名字，裁错了比不裁更烦人。
 *
 * @param {object} probe /api/probe-url 的返回
 * @param {string} curTitle 输入框里现有的频道名（用户可能已经打过字）
 * @returns {{name:string, reason:'sdt'|'filled'|'none'}}
 */
function suggestTitle(probe, curTitle) {
  const n = probe && probe.ok && probe.serviceName ? String(probe.serviceName).trim() : '';
  if (!n) return { name: '', reason: 'none' };
  return String(curTitle || '').trim() ? { name: '', reason: 'filled' } : { name: n, reason: 'sdt' };
}

/**
 * 对着「播放地址」框的实时检测：停手一会儿就探一次，把流里的 SDT 服务名
 * 顺手填进频道名，同时给一份**体检报告** —— 分辨率、首字节延迟、标称码率，
 * 以及「这是录好的循环片 / 这是几段历史切片缝的」这类假直播判定。
 *
 * 报告下面挂两个勾：「带分辨率后缀」「带延迟后缀」，勾着就把对应后缀写进频道名
 * （默认都勾，不想要就取消）。刻意做成**由你点头才写** —— 工具栏那两个「回填」
 * 是批量全局动作，而这里只影响你正在建的这一条，悄悄改名字比留着让人猜更糟。
 *
 * 为什么是防抖而不是每次敲键都探：一次探测要往下挖到 2MB（SPS 和 SDT 都不在流头，
 * 实测 112.123 那条的服务名在 1.7MB 处没影、SPS 在 604KB）。打字过程中每敲一个字符
 * 发一次请求，源站和本机都吃不消。停手 700ms 再发，地址看着像 http(s) 才发，
 * file:// 之类的一律不碰。
 *
 * @returns {{applyTitle(base:string):string}} 点确定时按勾选项算出最终频道名
 */
function watchStreamUrl() {
  const inp = $('#modalFields textarea[data-k="url"]') || $('#modalFields input[data-k="url"]');
  const box = document.getElementById('mpmStreamInfo');
  if (!inp || !box) return { applyTitle: (s) => String(s || '') };
  let timer = 0;
  let seq = 0; // 请求序号：只有「最后一发」的结果能写进界面
  let filled = ''; // 上一轮自动填进去的名字，换地址时用它判断旧名字该不该撤掉
  let last = null; // 最近一次探测结果：报告、勾选、后缀三个都取自它

  const titleEl = () => $('#modalFields input[data-k="title"]') || $('#modalFields textarea[data-k="title"]');
  const el = (id) => document.getElementById(id);
  const setInfo = (html) => {
    box.innerHTML = html;
  };

  /** 档位："1920x1080 (1080p)" -> "1080p"，跟表格「回填分辨率」取数的方式完全一致 */
  const tierOfProbe = (p) => {
    const m = p && p.ok && p.format ? /\(([^)]+)\)/.exec(p.format) : null;
    return m && m[1] ? m[1] : '';
  };

  /**
   * 按当前勾选把后缀拼到名字上。
   *
   * 顺序必须是**先分辨率、再延迟**：延迟后缀老老实实待在最后（工具栏「回填延迟」
   * 就是这么放的），反着拼会出来「凤凰 320ms 1080p」这种档位挂在延迟后面的怪名字。
   * 两个都没勾、或压根没测到值，就原样返回 —— 没有真值的后缀绝不硬写。
   */
  const suffixName = (base) => {
    const p = last || {};
    const tier = el('mpmSufRes') && el('mpmSufRes').checked ? tierOfProbe(p) : '';
    const ms = el('mpmSufDelay') && el('mpmSufDelay').checked && p.ok ? p.ttfbMs || 0 : 0;
    if (!tier && !ms) return String(base || '');
    let n = String(base || '');
    if (tier) n = rebuildResName({ title: n, tier });
    if (ms) n = rebuildName({ title: n, ms });
    return String(n).trim();
  };

  /** 预览：勾一下、改个名字都能立刻看到成品频道名长什么样 */
  const refreshPreview = () => {
    const pv = el('mpmNamePreview');
    if (!pv) return;
    pv.textContent = suffixName(titleEl() ? titleEl().value : '') || t('（还没填频道名）');
  };

  /** 报告卡：状态那一格直接复用表格里的 stateCell，免得同一个「在线」在两处两种长相 */
  const healthHtml = (p) => {
    const noFmtTip = esc(p.noResText || explainNoRes(p));
    const item = (k, v, tip) =>
      `<span class="hlt-i"><span class="hlt-k">${esc(k)}</span><span class="hlt-v"${
        tip ? ` title="${tip}"` : ''
      }>${v}</span></span>`;
    let warn = '';
    if (p.fakeLive)
      warn = `<div class="hlt-warn">⚠ ${esc(t('不是实时直播：{why}', { why: p.fakeLiveWhy || '' }))}</div>`;
    else if (p.seamLive)
      warn = `<div class="hlt-warn seam">⚠ ${esc(
        p.seamLiveWhy || t('这不是实时直播，是几段历史切片缝起来的'),
      )}</div>`;
    const none = '<span class="hlt-none">—</span>';
    const p0 = p || {};
    const ms = p0.ok ? p0.ttfbMs || 0 : 0;
    const kbps = p0.ok ? p0.bandwidthMbps || 0 : 0;
    const tier = tierOfProbe(p0);
    return (
      `<div class="hlt">` +
      `<div class="hlt-line">${stateCell(p0)}` +
      item(t('分辨率'), tier ? esc(p0.format) : none, tier ? '' : noFmtTip) +
      item(t('首字节延迟'), ms ? `<span class="v-${ms > 600 ? 'bad' : ms > 250 ? 'warn' : 'ok'}">${ms}ms</span>` : none) +
      item(t('标称码率'), kbps ? `${esc(kbps)}M` : none, kbps ? '' : esc(t('这条没读到标称码率'))) +
      `</div>` +
      warn +
      `<div class="hlt-line hlt-suf">` +
      `<span class="hlt-chk"><input type="checkbox" id="mpmSufRes"><label for="mpmSufRes">${esc(
        t('带分辨率后缀'),
      )}</label></span>` +
      `<span class="hlt-chk"><input type="checkbox" id="mpmSufDelay"><label for="mpmSufDelay">${esc(
        t('带延迟后缀'),
      )}</label></span>` +
      `<span class="hlt-pv"><span class="m-sub">${esc(t('频道名'))}</span> <b id="mpmNamePreview"></b></span>` +
      `</div></div>`
    );
  };

  const schedule = () => {
    clearTimeout(timer);
    const v = inp.value.trim();
    if (!/^https?:\/\/\S{6,}$/i.test(v)) {
      seq++; // 不再是可探测的地址，在飞的旧结果作废
      last = null; // 报告也一起撤掉，否则会挂着上一个地址的体检结果
      setInfo('');
      return;
    }
    // 换了地址，上一轮自动填的名字就过期了，先撤掉，让新一轮重新填
    const ti = titleEl();
    if (filled && ti && ti.value === filled) ti.value = '';
    filled = '';
    timer = setTimeout(run, 700);
  };

  async function run() {
    const v = inp.value.trim();
    const mine = ++seq;
    setInfo(`<span class="si-wait">${esc(t('正在检测这条地址…'))}</span>`);
    let j = {};
    try {
      const r = await fetch(`/api/probe-url?url=${encodeURIComponent(v)}`);
      j = await r.json().catch(() => ({}));
    } catch {}
    if (mine !== seq) return; // 等结果这会儿地址又改了，这个结果作废

    last = j; // 报告 / 勾选 / 后缀都以这一份为准
    const sug = suggestTitle(j, titleEl() ? titleEl().value : '');
    let line;
    if (sug.reason === 'none') {
      line = `<div class="hlt-name si-low">${esc(t('这条地址没读到流内服务名（源站没写 SDT，或这条流连不上）'))}</div>`;
    } else if (sug.reason === 'filled') {
      line = `<div class="hlt-name si-low">${esc(
        t('流内服务名「{n}」，频道名已经填过了，不去覆盖', { n: sug.name }),
      )}</div>`;
    } else {
      const ti = titleEl();
      if (ti) {
        ti.value = sug.name;
        filled = sug.name;
      }
      line = `<div class="hlt-name si-ok">${esc(
        t('流内服务名「{n}」→ 已填入频道名，不用就自己改', { n: sug.name }),
      )}</div>`;
    }
    // 报告每次重写这个盒子，DOM 是新的，勾选与预览的事件得重新挂一遍
    setInfo(healthHtml(j) + line);
    ['mpmSufRes', 'mpmSufDelay'].forEach((id) => {
      const c = el(id);
      if (c) c.addEventListener('change', refreshPreview);
    });
    const ti = titleEl();
    if (ti) ti.addEventListener('input', refreshPreview);
    refreshPreview();
  }

  inp.addEventListener('input', schedule);
  // 进来时地址可能已经是填好的（比如照着某条新增），那就直接探一次，别让人白等
  schedule();
  return { applyTitle: (base) => suffixName(base) };
}

function openEntryModal(entry, opts = {}) {
  const isNew = !entry;
  entry = entry || { title: '', attrs: [], attrMap: {}, url: '' };
  const fields = [
    // 地址放第一个：新增频道的基本动作就是「粘个地址 → 看它认不认得出频道名」，
    // 先问地址，剩下的（名字 / 分组 / tvg）都是顺带填的
    { key: 'url', label: t('播放地址'), value: isNew ? '' : entry.url || '', type: 'textarea' },
    // 检测结论的落脚点：探测中 / 读到的流内服务名 / 没读到，都写在这一行里
    { type: 'html', html: '<div class="stream-info" id="mpmStreamInfo"></div>' },
    { key: 'title', label: t('频道显示名'), value: isNew ? '' : nameOf(entry) },
    // 跟表头、行内格同一套顺序：频道名 → tvg-id → 分组
    { key: 'tvg-id', label: 'tvg-id', value: isNew ? '' : idOf(entry) },
    // 新增时继承当前筛选中的分组：列表里已经有分组了就顺手带上，手打一下即换组
    { key: 'group', label: t('分组 group-title'), value: isNew ? state.group || '' : grpOf(entry), datalist: groupChoices() },
    { key: 'tvg-logo', label: t('LOGO 地址 tvg-logo'), value: isNew ? '' : logoOf(entry), type: 'textarea' },
  ];
  // 体检报告的句柄：它在地址框下方实时跑，点确定时由它决定「要不要把后缀写进频道名」
  let health = null;
  openModal(isNew ? t('添加新频道') : t('编辑频道'), fields, (v) => {
    let parsed = null; // 新增的频道要重新登记给服务端，否则探测不到它
    if (isNew) {
      // 报告上勾了哪些后缀，就在这里落成频道名；一个都没勾就原样，一个字都不动
      const title = health ? health.applyTitle(v.title) : v.title;
      parsed = parseExtinf(`#EXTINF:-1 group-title="${v.group}" tvg-id="${v['tvg-id']}" tvg-logo="${v['tvg-logo']}",${title}`);
      parsed.url = v.url.trim();
      parsed.comments = [];
      parsed.id = 'e' + Math.random().toString(36).slice(2, 8);
      parsed.probe = null;
      state.entries.push(parsed);
    } else {
      entry.title = v.title;
      if (entry.title !== nameOf(entry)) markTouched(entry, 'title');
      const newUrl = v.url.trim();
      if (newUrl !== entry.url) {
        entry.url = newUrl;
        markTouched(entry, 'url'); // 手换过地址，「从源站更新」就不该再刷回去
      }
      ['group-title', 'tvg-id'].forEach((k) => setAttr(entry, k, v[k] || ''));
      setLogo(entry, v['tvg-logo']);
    }
    state.doc.dirty = true;
    // 新加的频道要同步登记给服务端，否则「开始测速探测」测不到它
    if (parsed && parsed.url) registerWithServer();
    refreshGroupOptions();
    if (entry) refreshLogoCell(entry); // 新增的频道还没在表格里，不用刷这一行
    render();
  });
  // 边填边检测：地址停手一会儿就去探一次，读到流内服务名就顺手填进频道名。
  // 只在新增时开 —— 编辑已有频道时名字是用户自己的，不能被流里的字串顶掉
  // （真要填也有 suggestTitle 的 'filled' 分支挡着，这里干脆不启动）。
  if (isNew) health = watchStreamUrl();
  // 预填的分组一聚焦就是全选：切到这个框打字自然换组，不改则沿用当前分组
  if (isNew && state.group) {
    const g = $('#modalFields input[data-k="group"]');
    if (g) g.addEventListener('focus', () => g.select(), { once: true });
  }
  // 从表格单元格点 ✎ 进来时，多半是想改地址，光标直接落在地址上
  if (opts.focus === 'url') {
    const inp = $('#modalFields textarea[data-k="url"]') || $('#modalFields input[data-k="url"]');
    if (inp) {
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
    }
  }
}

/* ---------------- 语言 ---------------- */

/**
 * 切语言不刷新页面：列表、勾选、编辑全在内存里，reload 会让人白干一轮。
 * 所以这里只做两件事 —— 把 [data-i18n] 那批静态文案刷回去，再重绘表格
 * （行内的 ▶ / 状态 chip 文案都是渲染时才拼的）和底栏统计。
 */
applyStatic();
mountLangSwitch();
onLangChange(() => {
  applyStatic();
  render();
  syncSelectionUI();
});
