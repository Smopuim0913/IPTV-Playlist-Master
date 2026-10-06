/**
 * 探测失败重试：目的是别把「抖一下」的源误判成死链。
 *
 * 假源站各扮演一种真实场景：
 *   1. 503 抖两下再放行（源站临时拥挤）
 *   2. 一直 503（真挂）
 *   3. 前两次不回包（链路抖动），第三次才响应
 *   4. 403 → 换播放器 UA 就放行
 *   5. 死活 403（真的要 Referer/授权）
 *   6. 域名不存在（永久错误，不许重试浪费时间）
 *   7. 同域名闸门：同源请求之间要留出间隔
 */
import http from 'node:http';
import { probeUrl, probeMany } from '../src/probe.js';

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=1920x1080
chunk0.m3u8
`;

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

const hits = { flaky: 0, hang: 0, ua403: 0, hard403: 0 };
const pendingTimers = new Set();

const server = http.createServer((req, res) => {
  const sendMaster = () => {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(MASTER);
  };

  if (req.url.startsWith('/flaky')) {
    // 前两次 503，第三次放行
    if (++hits.flaky <= 2) {
      res.writeHead(503);
      return res.end('busy');
    }
    return sendMaster();
  }

  if (req.url.startsWith('/always503')) {
    res.writeHead(503);
    return res.end('busy');
  }

  if (req.url.startsWith('/hang')) {
    // 前两次干脆不回包 —— 客户端会自己超时
    if (++hits.hang <= 2) {
      const t = setTimeout(() => {
        pendingTimers.delete(t);
        try {
          sendMaster();
        } catch {}
      }, 5000);
      pendingTimers.add(t);
      return;
    }
    return sendMaster();
  }

  if (req.url.startsWith('/ua403')) {
    const ua = req.headers['user-agent'] || '';
    if (++hits.ua403 > 1 || ua.includes('Lavf')) return sendMaster();
    res.writeHead(403);
    return res.end('forbidden');
  }

  if (req.url.startsWith('/hard403')) {
    res.writeHead(403);
    return res.end('forbidden');
  }

  res.writeHead(404);
  res.end();
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

console.log('探测失败重试');

/* 1. 抖动后恢复：必须当成在线 */
const flaky = await probeUrl(`${base}/flaky.m3u8`);
ok('503 抖两下后放行 → 判定在线', flaky.ok === true, JSON.stringify(flaky.note));
ok('确实试了 3 次', flaky.attempts === 3, String(flaky.attempts));
ok('retried 记的是重试次数', flaky.retried === 2, String(flaky.retried));
ok('恢复后分辨率照常读出', !!flaky.format && flaky.format.includes('1080'), flaky.format);

/* 2. 一直 503：判失败，但要说明试过几次 */
const dead = await probeUrl(`${base}/always503.m3u8`);
ok('一直 503 → 判定失败', dead.ok === false);
ok('一直 503 →  attempts 封顶 3', dead.attempts === 3, String(dead.attempts));
ok('失败说明里带重试次数', /重试 2 次仍失败/.test(dead.note || ''), dead.note);

/* 3. 前两次不回包（超时）也算瞬时故障 */
const hung = await probeUrl(`${base}/hang.m3u8`, { timeout: 150 });
ok('超时两次后恢复 → 判定在线', hung.ok === true, JSON.stringify(hung.note));
ok('超时路径也重试用满了', hung.attempts === 3 && hung.retried === 2, `${hung.attempts}/${hung.retried}`);

/* 4. 403 换播放器 UA 就放行 */
const ua = await probeUrl(`${base}/ua403.m3u8`);
ok('403 后换 UA 放行 → 判定在线', ua.ok === true, JSON.stringify(ua.note));
ok('403 恢复有标记', ua.uaswitch === true);
ok('403 恢复的原因写在说明里', /换播放器 UA 后放行/.test(ua.note || ''), ua.note);

/* 5. 死活 403：只换一次 UA，别无限试 */
const hard = await probeUrl(`${base}/hard403.m3u8`);
ok('一直 403 → 判定失败', hard.ok === false);
ok('403 最多试 2 次（换 UA 那次算一次）', hard.attempts === 2, String(hard.attempts));
ok('403 失败不是「源已失效」的措辞', /403/.test(hard.note || '') && !/源已失效/.test(hard.note || ''), hard.note);

/* 6. 永久错误（域名不存在）不许重试白等 */
const missing = await probeUrl('http://no-such-host.invalid/live/index.m3u8', { timeout: 1500 });
ok('域名不存在 → 判定失败', missing.ok === false);
ok('域名不存在只试 1 次（不是瞬时故障）', missing.attempts === 1, String(missing.attempts));

/* 7. 可以关掉重试 */
const noRetry = await probeUrl(`${base}/always503.m3u8`, { retries: 0 });
ok('retries=0 时只试一次', noRetry.attempts === 1, String(noRetry.attempts));

/* 8. 同域名闸门：同源请求之间留出间隔，别把自己并发挂住 */
const t0 = Date.now();
const { results } = await probeMany(
  ['/a.m3u8', '/b.m3u8', '/c.m3u8', '/d.m3u8'].map((p, i) => ({ id: `x${i}`, url: `${base}${p}` })),
  { concurrency: 4, timeout: 2000, hostGap: 200 },
);
const gap = Date.now() - t0;
ok('同源 4 条全部有结论', results.length === 4, String(results.length));
ok(`同源被间隔开（耗时 ${gap}ms ≥ 600ms）`, gap >= 600, String(gap));

// 不同域名之间不互相排队
const t1 = Date.now();
await probeMany(
  [
    { id: 'h1', url: `http://127.0.0.1:${server.address().port}/a.m3u8` },
    { id: 'h2', url: `http://localhost:${server.address().port}/a.m3u8` },
    { id: 'h3', url: `http://127.0.0.1:${server.address().port}/b.m3u8` },
  ],
  { concurrency: 3, timeout: 2000, hostGap: 300 },
);
const crossGap = Date.now() - t1;
ok(`不同域名不排队（耗时 ${crossGap}ms < 500ms）`, crossGap < 500, String(crossGap));

pendingTimers.forEach((t) => clearTimeout(t));
server.close();
console.log(failed ? `\n${failed} 项失败` : `\n${pass} 项全部通过`);
process.exit(failed ? 1 : 0);
