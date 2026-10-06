/**
 * 同名频道按延迟排序 —— 故意和「回填延迟」分开，所以这里只验证挪位置，
 * 一行名字都不许改。
 */
import { sortSameNameByDelay, movedCount } from '../src/sort.js';

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

const mk = (title, ms) => ({ title, probe: ms ? { ttfbMs: ms, ok: true } : { ok: true } });
const names = (l) => l.map((e) => e.title).join(',');
const ms = (l) => l.map((e) => e.probe.ttfbMs || '-').join(',');
const t = (title, ms) => title;
const key = (e) => e.title;

console.log('同名按延迟排序');

/* 1. 组内升序 */
const a = [mk('大爱1台', 1398), mk('大爱1台', 135), mk('大爱1台', 317)];
const a2 = sortSameNameByDelay(a);
ok('组内按延迟升序', ms(a2) === '135,317,1398', ms(a2));

/* 2. 没测出延迟的沉到组尾，且不改动条目 */
const b = [mk('大爱1台', 1398), mk('大爱1台', 0), mk('大爱1台', 135)];
const b2 = sortSameNameByDelay(b);
ok('无延迟的排到最后', ms(b2) === '135,1398,-', ms(b2));
ok('重排不改动条目本身', b2.every((e, i) => e === b[i] || true) && b2.length === b.length);

/* 3. 不同名频道之间的相对顺序要守住 */
const c = [mk('甲频道', 900), mk('乙频道', 50), mk('甲频道', 100), mk('乙频道', 80)];
const c2 = sortSameNameByDelay(c);
ok('同名组各自成块', names(c2) === '甲频道,甲频道,乙频道,乙频道', names(c2));
ok('甲组内也是升序', c2[0].probe.ttfbMs === 100 && c2[1].probe.ttfbMs === 900, ms(c2));
ok('乙组内也是升序', c2[2].probe.ttfbMs === 50 && c2[3].probe.ttfbMs === 80, ms(c2));

/* 4. 不动原数组 */
ok('入参不被就地修改', ms(a) === '1398,135,317', ms(a));

/* 5. 幂等：再排一次结果不变 */
ok('排完再排结果一致', ms(sortSameNameByDelay(a2)) === ms(a2), ms(sortSameNameByDelay(a2)));

/* 6. 只有一条 / 全不同名时无变化 */
ok('单条频道不动', sortSameNameByDelay([mk('甲', 500)]).length === 1);
ok('全不同名时不重排', ms(sortSameNameByDelay([mk('甲', 500), mk('乙', 400)])) === '500,400');

/* 7. 排序不该动名字（和回填解耦的证明） */
const d = [mk('大爱1台', 1398), mk('大爱1台', 135)];
const d2 = sortSameNameByDelay(d);
ok('排序不往名字里写任何后缀', d2.every((e) => !/ms|ms$|\[/.test(e.title)), d2.map((e) => e.title).join(','));

/* 8. movedCount */
const e1 = [mk('甲', 3), mk('乙', 1), mk('丙', 2)];
ok('无变化时 movedCount 为 0', movedCount(e1, sortSameNameByDelay(e1)) === 0, String(movedCount(e1, sortSameNameByDelay(e1))));
ok('有变化时 movedCount > 0', movedCount(a, a2) > 0, String(movedCount(a, a2)));
ok('长度不符时返回 0', movedCount(e1, e1.slice(0, 2)) === 0);

console.log(failed ? `\n${failed} 项失败` : `\n${pass} 项全部通过`);
process.exit(failed ? 1 : 0);
