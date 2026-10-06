/**
 * 播放列表「更新」——把远端（源站）最新的列表合并进本地这张已经编辑过的表。
 *
 * 本地这张表不是远端的一份拷贝：用户可能换过地址、改过频道名、调过分组。
 * 所以这里的唯一铁律是：**本地手动改过的字段一律不覆盖**，
 * 远端只负责补「本地没有 / 本地还旧」的部分，并如实汇报改了什么。
 *
 * 匹配顺序：tvg-id → 频道名（都做归一化：去空格、去空白、忽略大小写）。
 * 同一个频道在远端换了地址时，按地址再兜一次，避免同名新源被当成「新增」塞进来。
 */

import { nextId } from './m3u.js';

/** 归一化用于比较：折叠空白、去零宽字符、忽略大小写和全半角空格 */
const norm = (s) =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[​-‍﻿]/g, '');

const keyOf = (e) => {
  const id = norm(e.attrMap ? e.attrMap['tvg-id'] : '');
  return id ? `id:${id}` : `name:${norm(e.title || (e.attrMap ? e.attrMap['tvg-name'] : ''))}`;
};
const urlKey = (e) => `url:${norm(e.url)}`;
const touched = (e, field) => !!(e.touched && e.touched.has(field));

function setAttr(e, key, val) {
  const a = e.attrs.find((x) => x.key === key);
  if (a) {
    a.value = val;
    a.raw = `${key}="${val}"`;
  } else {
    e.attrs.push({ key, value: val, raw: `${key}="${val}"` });
  }
  if (!e.attrMap) e.attrMap = Object.create(null);
  e.attrMap[key] = val;
}

/**
 * 用远端的一条条目刷新本地的一条。
 * @returns {{changed:number, blocked:number}} changed = 真改了几个字段；
 *   blocked = 远端确实有变化，但因为这个字段本地手改过而被挡下的个数
 */
function applyUpdate(cur, inc) {
  let changed = 0;
  let blocked = 0;

  // 地址：本地没手改过就听源站的（源站换源是更新里最常见的动作）
  if (touched(cur, 'url')) {
    if (inc.url && inc.url !== cur.url) blocked++; // 远端换源了，但这是本地挑的，不动
  } else if (inc.url && cur.url !== inc.url) {
    cur.url = inc.url;
    changed++;
  } else if (!inc.url && cur.url) {
    blocked++; // 远端把它删了，本地还留着
  }

  // 频道名：本地没改名就跟着远端走（改叫法、去掉后缀都算）
  if (touched(cur, 'title')) {
    if (inc.title && inc.title !== cur.title) blocked++;
  } else if (inc.title && cur.title !== inc.title) {
    cur.title = inc.title;
    changed++;
  } else if (!inc.title && cur.title) {
    blocked++;
  }

  // LOGO：本地没手填就采纳远端的（远端更可能是把坏图修好了）
  if (cur.attrMap) {
    const curLogo = cur.attrMap['tvg-logo'] || '';
    // 注意两边都要兜成空串：undefined !== '' 会被误判成「LOGO 变了」而虚报更新
    const incLogo = (inc.attrMap ? inc.attrMap['tvg-logo'] : '') || '';
    if (touched(cur, 'logo')) {
      if (curLogo !== incLogo) blocked++;
    } else if (curLogo !== incLogo) {
      if (incLogo) setAttr(cur, 'tvg-logo', incLogo);
      else {
        const i = cur.attrs.findIndex((x) => x.key === 'tvg-logo');
        if (i >= 0) cur.attrs.splice(i, 1);
        delete cur.attrMap['tvg-logo'];
      }
      changed++;
    }
  }
  // 分组只补空：用户自己归过组，不该被源站推回去重排
  if (!touched(cur, 'group') && cur.attrMap) {
    const incGroup = (inc.attrMap ? inc.attrMap['group-title'] : '') || '';
    if (!cur.attrMap['group-title'] && incGroup) {
      setAttr(cur, 'group-title', incGroup);
      changed++;
    }
  }

  return { changed, blocked };
}

function cloneIncoming(inc) {
  return {
    ...inc,
    comments: [...(inc.comments || [])],
    id: nextId(),
    probe: null,
    touched: new Set(),
  };
}

/**
 * 合并两份频道数组。
 *
 * @param {Array} current  本地（已编辑）
 * @param {Array} incoming 远端最新
 * @param {{append?:boolean, prune?:boolean}} opts
 *   append 默认 true —— 远端新增的频道补进来；
 *   prune 默认 false —— 远端删掉的频道本地保留（删文件是不可逆的，默认不动）。
 * @returns {{entries: Array, stats: {updated:number, added:number, kept:number, pruned:number, total:number}}}
 */
export function mergePlaylist(current, incoming, opts = {}) {
  const { append = true, prune = false } = opts;

  const entries = current.slice();
  /** 本地条目标记：已配对过，防止远端两条同名命中同一条本地频道 */
  const claimed = new Set();
  const byKey = new Map();
  const byUrl = new Map();
  for (const e of entries) {
    const k = keyOf(e);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
    if (e.url) byUrl.set(urlKey(e), e);
  }

  let updated = 0;
  let added = 0;
  let same = 0;
  let blocked = 0;

  for (const inc of incoming) {
    const k = keyOf(inc);
    const hit = (byKey.get(k) || []).find((e) => !claimed.has(e));

    if (hit) {
      claimed.add(hit);
      const r = applyUpdate(hit, inc);
      if (r.changed) updated++;
      else if (r.blocked > 0) blocked++; // 远端有更新，被本地手改挡下来了
      else same++; // 两边一模一样，这次更新到这儿没起作用
      continue;
    }

    // 同名但远端换地址了 —— 不是新增，别塞一条重复的进来
    if (inc.url && byUrl.has(urlKey(inc))) continue;
    if (!append) continue;

    entries.push(cloneIncoming(inc));
    byUrl.set(urlKey(inc), entries[entries.length - 1]);
    added++;
  }

  let result = entries;
  let pruned = 0;
  if (prune) {
    const incomingKeys = new Set(incoming.map(keyOf));
    result = entries.filter(
      (e) => claimed.has(e) || incomingKeys.has(keyOf(e)) || touched(e, 'title'),
    );
    pruned = entries.length - result.length;
  }

  return {
    entries: result,
    stats: { updated, added, same, blocked, pruned, total: result.length },
  };
}
