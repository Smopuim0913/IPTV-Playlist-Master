/**
 * 列表排序。
 *
 * 「回填延迟」只管往名字里写字，这个模块只管挪位置 —— 两件事故意分开：
 * 很多人的列表有自己的编排顺序（比如按运营商、按地区、按自己的心情），
 * 排序一旦和回填绑死，就没法单独用了。
 */

/**
 * 同名频道按延迟升序重排。
 *
 * 规则：
 *   - 只在**同名组内部**调整，不同名的频道之间保持原本的先后（首次出现顺序）
 *   - 组内有延迟的按 ttfbMs 升序，快的排在前面（挑源就是挑这个）
 *   - 没测出延迟的排到该组最后，组内保持原顺序，不影响在线判定
 *   - 返回新数组，不改动入参
 *
 * @param {Array} entries 频道数组
 * @param {{nameOf?:Function, msOf?:Function}} opts
 *        nameOf 取用于分组的名字（默认 e.title）
 *        msOf   取延迟毫秒（默认 e.probe.ttfbMs）
 */
export function sortSameNameByDelay(entries, opts = {}) {
  const nameOf = opts.nameOf || ((e) => String(e.title || '').trim());
  const msOf = opts.msOf || ((e) => Number((e.probe && e.probe.ttfbMs) || 0));

  // 同名分组，顺带记住原始下标（后面同名同延迟时用它保证稳定）
  const groups = new Map();
  entries.forEach((e, i) => {
    const key = nameOf(e) || `#${i}`; // 名字空着的各自成组，别把一堆无名频道挤到一组
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ e, i, ms: msOf(e) });
  });

  const out = [];
  for (const items of groups.values()) {
    if (items.length > 1) {
      const withMs = items.filter((it) => it.ms > 0).sort((a, b) => a.ms - b.ms || a.i - b.i);
      const without = items.filter((it) => !(it.ms > 0));
      for (const it of [...withMs, ...without]) out.push(it);
    } else {
      out.push(items[0]);
    }
  }
  return out.map((it) => it.e);
}

/** 有多少条的位置真的变了（用来给用户一句实话，而不是「已排序」三个字） */
export function movedCount(before, after) {
  if (!Array.isArray(after) || after.length !== before.length) return 0;
  const rank = new Map(after.map((e, i) => [e, i]));
  let n = 0;
  for (let i = 0; i < before.length; i++) if (rank.get(before[i]) !== i) n++;
  return n;
}
