/**
 * 「从源站更新」的合并逻辑 —— 本地手改过的字段必须挡住远端覆盖，
 * 这条是整个 Updater 的立足点，所以每条规则都单独钉一遍。
 */
import { parseM3U, serializeM3U } from '../src/m3u.js';
import { mergePlaylist } from '../src/merge.js';

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

/** 便捷构造：一条频道 = { title, url, attrMap, attrs } */
const ent = (title, url, extra = {}) => {
  const attrs = [];
  const attrMap = {};
  for (const [k, v] of Object.entries(extra.attrs || {})) {
    attrs.push({ key: k, value: v, raw: `${k}="${v}"` });
    attrMap[k] = v;
  }
  return { title, url, attrs, attrMap, duration: '-1', comments: [], id: `id-${Math.random().toString(36).slice(2, 6)}`, probe: extra.probe || null, touched: extra.touched || new Set() };
};

console.log('从源站更新（合并）');

/* ---------- 1. 按 tvg-id 匹配，远端换源本地跟着换 ---------- */
{
  const cur = [ent('CCTV-1 综合', 'http://old/cctv1.m3u8', { attrs: { 'tvg-id': 'cctv1' } })];
  const inc = [ent('CCTV-1 综合', 'http://new/cctv1.m3u8', { attrs: { 'tvg-id': 'cctv1' } })];
  const { entries, stats } = mergePlaylist(cur, inc);
  ok('同 tvg-id 换源被采纳', entries[0].url === 'http://new/cctv1.m3u8', entries[0].url);
  ok('统计里更新了 1 条', stats.updated === 1, JSON.stringify(stats));
  ok('总数不变', entries.length === 1);
}

/* ---------- 2. 本地手改过地址 → 源站不许刷回去 ---------- */
{
  const cur = [ent('CCTV-1 综合', 'http://mine/cctv1.m3u8', { attrs: { 'tvg-id': 'cctv1' }, touched: new Set(['url']) })];
  const inc = [ent('CCTV-1 综合', 'http://new/cctv1.m3u8', { attrs: { 'tvg-id': 'cctv1' } })];
  const { entries, stats } = mergePlaylist(cur, inc);
  ok('本地手改的地址不被覆盖', entries[0].url === 'http://mine/cctv1.m3u8', entries[0].url);
  ok('被挡下的要如实汇报', stats.blocked === 1 && stats.updated === 0, JSON.stringify(stats));
}

/* ---------- 3. 频道名：本地改名保住，没改名才跟远端 ---------- */
{
  const cur = [ent('CCTV-1 综合（本地改名）', 'http://a', { attrs: { 'tvg-id': 'cctv1' }, touched: new Set(['title']) })];
  const inc = [ent('CCTV-1 综合', 'http://a', { attrs: { 'tvg-id': 'cctv1' } })];
  ok('本地改过的名字不动', mergePlaylist(cur, inc).entries[0].title === 'CCTV-1 综合（本地改名）');

  const cur2 = [ent('CCTV-1 综合', 'http://a', { attrs: { 'tvg-id': 'cctv1' } })];
  const inc2 = [ent('CCTV-1 综合 1080p', 'http://a', { attrs: { 'tvg-id': 'cctv1' } })];
  ok('没改名时采纳远端新名字', mergePlaylist(cur2, inc2).entries[0].title === 'CCTV-1 综合 1080p');
}

/* ---------- 4. LOGO：本地空则补，本地手填则留 ---------- */
{
  const cur = [ent('甲', 'http://a')];
  const inc = [ent('甲', 'http://a', { attrs: { 'tvg-logo': 'http://logo/a.png' } })];
  ok('本地没 LOGO 时补上远端的', mergePlaylist(cur, inc).entries[0].attrMap['tvg-logo'] === 'http://logo/a.png');

  const cur2 = [ent('甲', 'http://a', { attrs: { 'tvg-logo': 'http://mine.png' }, touched: new Set(['logo']) })];
  ok('本地手填的 LOGO 不被覆盖', mergePlaylist(cur2, inc).entries[0].attrMap['tvg-logo'] === 'http://mine.png');

  // 远端把坏 LOGO 去掉，本地没填过 → 也别留着空属性
  const cur3 = [ent('甲', 'http://a', { attrs: { 'tvg-logo': 'http://bad.png' } })];
  const inc3 = [ent('甲', 'http://a')];
  const r3 = mergePlaylist(cur3, inc3).entries[0];
  ok('远端去掉 LOGO 时本地同步清掉', !r3.attrMap['tvg-logo'] && !r3.attrs.some((a) => a.key === 'tvg-logo'), JSON.stringify(r3.attrs));
}

/* ---------- 5. 分组只补空，不把用户归好的组推回去 ---------- */
{
  const cur = [ent('甲', 'http://a', { attrs: { 'tvg-id': 'a' } })];
  const inc = [ent('甲', 'http://a', { attrs: { 'tvg-id': 'a', 'group-title': '央视' } })];
  ok('本地没分组时补上远端分组', mergePlaylist(cur, inc).entries[0].attrMap['group-title'] === '央视');

  const cur2 = [ent('甲', 'http://a', { attrs: { 'tvg-id': 'a', 'group-title': '我的央视' }, touched: new Set(['group']) })];
  ok('本地归过组的不被推回', mergePlaylist(cur2, inc).entries[0].attrMap['group-title'] === '我的央视');
}

/* ---------- 6. 远端新增 → 追加；远端删掉 → 默认保留 ---------- */
{
  const cur = [ent('甲', 'http://a', { attrs: { 'tvg-id': 'a' } })];
  const inc = [ent('甲', 'http://a', { attrs: { 'tvg-id': 'a' } }), ent('乙', 'http://b', { attrs: { 'tvg-id': 'b' } })];
  const r = mergePlaylist(cur, inc);
  ok('远端新增的追加进来', r.entries.length === 2 && r.stats.added === 1, JSON.stringify(r.stats));
  ok('新频道带新 id 且没探测结果', r.entries[1].id !== cur[0].id && r.entries[1].probe === null);

  // 没勾 prune：远端已移除的频道本地留着（删文件不可逆，默认不动）
  const r2 = mergePlaylist(cur, [ent('甲', 'http://a', { attrs: { 'tvg-id': 'a' } })]);
  ok('不勾 prune 时远端删掉的频道保留', r2.entries.length === 1 && r2.stats.pruned === 0);

  // 远端把「乙」去掉了，勾了 prune 才删（默认留着，删文件不可逆）
  const cur3 = [ent('甲', 'http://a', { attrs: { 'tvg-id': 'a' } }), ent('乙', 'http://b', { attrs: { 'tvg-id': 'b' } })];
  const inc3 = [ent('甲', 'http://a', { attrs: { 'tvg-id': 'a' } })];
  const r3 = mergePlaylist(cur3, inc3, { prune: true });
  ok('勾了 prune 才删掉远端已移除的', r3.entries.length === 1 && r3.stats.pruned === 1, JSON.stringify(r3.stats));
  ok('prune 不会误删远端还有的频道', r3.entries[0].title === '甲');

  // 本地改过名的频道，即使远端没了也不许删（那是用户自己的频道）
  const cur4 = [ent('甲（本地改名）', 'http://a', { attrs: { 'tvg-id': 'a' }, touched: new Set(['title']) })];
  const r4 = mergePlaylist(cur4, [], { prune: true });
  ok('本地改名过的频道 prune 时保留', r4.entries.length === 1);
}

/* ---------- 7. 同名不必然是同一条：按 url 去重，但同名新源照收 ---------- */
{
  const cur = [ent('甲', 'http://a', { attrs: { 'tvg-id': 'a' } })];
  const inc = [ent('甲', 'http://a', { attrs: { 'tvg-id': 'a' } })];
  const r = mergePlaylist(cur, inc);
  ok('远端又发一遍同一地址不重复追加', r.entries.length === 1 && r.stats.added === 0, JSON.stringify(r.stats));

  // 多源是这个项目的常态（同名几十条源靠延迟挑），远端补来的新源要照单全收
  const cur2 = [ent('甲', 'http://a')];
  const inc2 = [ent('甲', 'http://a'), ent('甲', 'http://b')];
  const r2 = mergePlaylist(cur2, inc2);
  ok('同名不同地址算两个源，正常追加', r2.entries.length === 2 && r2.stats.added === 1, JSON.stringify(r2.stats));
}

/* ---------- 8. 归一化匹配：大小写 / 空白 / tvg-id 与名字混用 ---------- */
{
  const cur = [ent('CCTV-1 综合', 'http://a', { attrs: { 'tvg-id': 'CCTV-1' } })];
  const inc = [ent('cctv-1 综合', 'http://a', { attrs: { 'tvg-id': 'cctv1' } })];
  const { entries } = mergePlaylist(cur, inc);
  ok('tvg-id 大小写不敏感', entries.length === 1);
  ok('按 id 匹配时不看名字是否相同', entries[0].url === 'http://a');

  const cur2 = [ent('  大爱  1台 ', 'http://a')];
  const inc2 = [ent('大爱 1台', 'http://new')];
  ok('频道名空白归一化后仍能匹配', mergePlaylist(cur2, inc2).entries[0].url === 'http://new');

  // 没 tvg-id 时用频道名匹配
  const cur3 = [ent('甲频道', 'http://old')];
  const inc3 = [ent('甲频道', 'http://new')];
  ok('无 tvg-id 时按频道名匹配', mergePlaylist(cur3, inc3).entries[0].url === 'http://new');
}

/* ---------- 9. 已有的探测结果不能被合并冲掉 ---------- */
{
  const probe = { ok: true, ttfbMs: 137, format: '1920x1080 (1080p)', status: 200 };
  const cur = [ent('甲', 'http://a', { attrs: { 'tvg-id': 'a' }, probe })];
  const inc = [ent('甲', 'http://a', { attrs: { 'tvg-id': 'a' } })];
  ok('匹配上的频道保留本地探测结果', mergePlaylist(cur, inc).entries[0].probe === probe);
}

/* ---------- 10. 走真实解析：合并结果必须还能序列化回 m3u ---------- */
{
  const doc = parseM3U('#EXTM3U\n#EXTINF:-1 tvg-id="a" group-title="央视" tvg-logo="http://l/a.png",甲\nhttp://a\n');
  doc.entries[0].touched = new Set();
  const inc = parseM3U('#EXTM3U\n#EXTINF:-1 tvg-id="a" group-title="央视" tvg-logo="http://l/a.png",甲\nhttp://a-v2\n#EXTINF:-1 tvg-id="b" group-title="央视",乙\nhttp://b\n');
  const { entries, stats } = mergePlaylist(doc.entries, inc.entries);
  const text = serializeM3U({ header: '#EXTM3U', entries, trailingNewline: true });
  ok('合并结果能原样序列化', text.includes('http://a-v2') && text.includes('http://b'), text);
  ok('序列化不写 touched 之类的内部字段', !text.includes('touched'), text);
  ok('顺带新增了远端那条', stats.added === 1 && entries.length === 2, JSON.stringify(stats));
  ok('重新解析回来条数一致', parseM3U(text).entries.length === 2);
}

/* ---------- 11. 两边一模一样：一条都不该动 ---------- */
{
  const cur = [ent('甲', 'http://a'), ent('乙', 'http://b')];
  const inc = [ent('甲', 'http://a'), ent('乙', 'http://b')];
  const { stats } = mergePlaylist(cur, inc);
  ok('无变化时统计全为 0', stats.updated === 0 && stats.added === 0 && stats.blocked === 0, JSON.stringify(stats));
}

console.log(failed ? `\n${failed} 项失败` : `\n${pass} 项全部通过`);
process.exit(failed ? 1 : 0);
