/**
 * 探测时「保留多少字节」必须跟得上「收了多少字节」。
 *
 * 起因：requestOnce 里曾写死「最多留 8 个网络块」。块多大是 TCP 说了算，不是我们
 * 说了算。实测某运营商源每块只有 3~4KB，probeBytes=400000 明明收了 400KB，body
 * 却只剩 29KB —— 分片开头的 PAT/PMT/SPS 全在被丢掉的部分里，分辨率于是「读不到」；
 * 同一条流换个时刻块大一点，同样的代码又能读出来。结果全看运气，必须钉死。
 *
 * 假源站扮演：一个「碎块」源，每块只有 4KB，无限流；以及一个正常 64KB 大块的源。
 */
import http from 'node:http';
import { requestOnce } from '../src/probe.js';

const pass = [];
const fail = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass.push(name);
    console.log(`  PASS ${name}`);
  } else {
    fail.push(name);
    console.log(`  FAIL ${name}${extra ? ' → ' + extra : ''}`);
  }
};

/** 一直往客户端灌字节的假源：chunkSize 决定它有多「碎」 */
function dribbling(chunkSize) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      const timer = setInterval(() => {
        try {
          res.write(Buffer.alloc(chunkSize, 0x47));
        } catch {
          clearInterval(timer);
        }
      }, 1);
      req.on('close', () => {
        clearInterval(timer);
        try {
          res.destroy();
        } catch {}
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const at = (srv) => `http://127.0.0.1:${srv.address().port}/seg.ts`;

// 1) 碎块源（每块 4KB）：旧代码最多留 8 块 = 32KB
{
  const srv = await dribbling(4096);
  const r = await requestOnce(at(srv), { timeout: 8000, probeBytes: 131072 });
  srv.close();
  ok('碎块源：收到的字节够多', r.bytes >= 131072, `bytes=${r.bytes}`);
  // 只留 8 块的话这里会是 32768 上下
  ok('碎块源：保留量贴近 probeBytes', r.body.length >= 131072 * 0.9, `body=${r.body.length}`);
  ok('碎块源：保留量不超过 probeBytes 一个块太多', r.body.length <= 131072 + 8192, `body=${r.body.length}`);
  ok('碎块源：标记了截断', !!r.truncated);
}

// 2) 极端：每块 2KB，仍然留得下大半
{
  const srv = await dribbling(2048);
  const r = await requestOnce(at(srv), { timeout: 8000, probeBytes: 65536 });
  srv.close();
  ok('超碎块源：保留量贴近 probeBytes', r.body.length >= 65536 * 0.9, `body=${r.body.length}（旧代码只有 16KB）`);
}

// 3) 大块源：保留量仍受 probeBytes 约束，不会无限涨
{
  const srv = await dribbling(65536);
  const r = await requestOnce(at(srv), { timeout: 8000, probeBytes: 65536 });
  srv.close();
  ok('大块源：保留量不超过 probeBytes', r.body.length <= 65536 * 2, `body=${r.body.length}`);
  ok('大块源：至少留了几个块', r.body.length >= 65536, `body=${r.body.length}`);
}

// 4) 完整响应（非流）也要完整拿到
{
  const payload = Buffer.alloc(50000, 0x47);
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200);
      res.end(payload);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const r = await requestOnce(at(srv), { timeout: 8000, probeBytes: 131072 });
  srv.close();
  ok('完整响应：全量拿到', r.body.length === payload.length, `${r.body.length}/${payload.length}`);
  ok('完整响应：不误报截断', !r.truncated);
}

console.log(`\n${fail.length ? '有用例失败' : '全部通过'}（${pass.length} 项）`);
process.exit(fail.length ? 1 : 0);
