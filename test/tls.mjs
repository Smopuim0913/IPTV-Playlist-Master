/**
 * 验证「证书不可信」不再被直接判成死链。
 *
 * 起一个自签名证书的 HTTPS 假源站（域名故意对不上），
 * 确认 probeUrl 会跳过证书校验重试一次，并把它标成「可播但有告警」。
 */
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeUrl } from '../src/probe.js';

// 证书由 test/gen-cert.sh 生成；Node 在 Windows 上看到的是盘符路径，不能用 /tmp
const bundle = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.tmp', 'bundle.pem'),
  'utf8',
);

let connections = 0;
const server = https.createServer(
  { key: bundle, cert: bundle },
  (req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    res.end(Buffer.alloc(2048, 7));
  },
);
// 严格校验那次握手在 TLS 层就挂了，不会走到 secureConnection；
// 于是第二次（跳过证书校验那次）会被掐断，模拟「证书不可信但源也真死了」。
server.on('secureConnection', (socket) => {
  connections++;
  if (connections >= 2) socket.destroy();
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? `  ${extra}` : ''));
  if (!cond) failed++;
};

try {
  const url = `https://127.0.0.1:${port}/live.ts`;

  const r = await probeUrl(url, { timeout: 5000 });

  // 严格校验下这源站必然被拒，但重试应该救回来
  ok('证书不匹配时仍判定可用', r.ok === true, `ok=${r.ok}`);
  ok('标记为 tlsInsecure', r.tlsInsecure === true, String(r.tlsInsecure));
  ok('状态是 200', r.status === 200, String(r.status));
  ok('拿到了延迟数据', (r.ttfbMs || 0) > 0, `${r.ttfbMs}ms`);
  ok('note 说明证书被跳过', /证书/.test(r.note || ''), r.note);

  // 直连流不该算「吞吐」，只测了 2KB 算出来的是噪音
  ok('直连流不显示噪音吞吐', !r.mbps, `mbps=${r.mbps}`);

  // 关掉重试开关，应该如实失败并给出人话
  const off = await probeUrl(url, { timeout: 5000, noInsecureRetry: true });
  ok('关掉重试会失败', off.ok === false, `ok=${off.ok}`);
  ok('失败原因不是原始错误码直抛', !/ERR_TLS/.test(off.note || ''), off.note);
  ok('失败原因能看懂', /证书|域名/.test(off.note || ''), off.note);

  // 跳过证书校验也连不上 —— 源是真死了，提示不能还「鼓励」用户留着它
  const dead = await probeUrl(url, { timeout: 5000 });
  ok('重试也失败时判定为死链', dead.ok === false, `ok=${dead.ok}`);
  ok('提示说明重试后仍失败', /跳过证书校验重试后仍连不上/.test(dead.note || ''), dead.note);
  ok('提示带出第二次失败原因', /（.+）/.test(dead.note || ''), dead.note);
  ok('不再做任何「仍能播」的承诺', !/仍能播|通常仍能/.test(dead.note || ''), dead.note);
} finally {
  server.close();
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
