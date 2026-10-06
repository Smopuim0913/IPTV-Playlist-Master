# IPTV Playlist Master

> **[English](README.en.md) · 简体中文（本页）** · 界面支持中英切换（顶栏 `英文` / `中文`）

> **免责**：本项目只处理**你自己已有的**播放列表。不内置、不提供、不代理任何 IPTV 源，
> 探测与播放都在本机完成；源站地址由你手动导入。

## English TL;DR

**Not just an editor** — this tool chains **check · edit · update** in one pass: import an m3u / m3u8
playlist, probe every source in bulk to see whether it actually plays and what resolution / latency it
has, clean or fill channel names, then save back over the file or export a copy. Zero third-party
dependencies; Node 18+ and it runs.

```bash
npm start          # http://localhost:8777 by default
PORT=9200 npm start
npm test           # 12 test suites
```

Highlights: bulk **speed probe** with streaming SSE results (TTFB + throughput + stutter risk),
**resolution read from the video stream header** when the source omits `RESOLUTION`, **merge from
source** without overwriting anything you edited locally, **one player window** no matter how many
channels you queue, and **non-lossy export** that keeps `response-time` / `catchup` /
`catchup-source` / `timeshift` and every private attribute verbatim.

The full English write-up is in **[README.en.md](README.en.md)** — the sections below are the
Chinese detailed version.

---

不只是编辑器——**体检（Checker）· 编辑（Editor）· 更新（Updater）** 三件事一条链路做完：
导入 m3u / m3u8 播放列表，批量探测每个源到底能不能播、分辨率多少、延迟多高，
清洗 / 回填频道名，最后覆盖保存或导出。零第三方依赖，Node 18+ 直接跑。

启动：

```bash
npm start          # 默认 http://localhost:8777
PORT=9200 npm start
npm test           # 31 套测试
```

31 套测试（`npm test` 一条命令串着跑）：解析往返 / 端到端 / 导出 / 国际化 / TLS / 分辨率 /
无分辨率归因 / 伪直播与拼接窗口 / 拖拽排序 / 播放器 / 源站合并 / 后缀 / 排序 / 重试。
（`npm run test:<名字>` 可以单独跑某一套。）

## 为什么不是纯网页

浏览器直接探测 IPTV 源站会被 CORS 卡死（源站基本不发跨域头）。这里由本机 Node 服务代发请求，
网页形态一样能用，又不必上 Tauri/Electron 那套桌面端工具链。播放列表与探测结果都不出本机。

## 为什么也不是桌面应用

有两个能力看着像得做成 exe 才能有，实际都是**服务端纯 Node 就能干**的事，网页照样给：

- **补全分辨率（读视频流头）**：直接连流 / HLS 子清单里没写 `RESOLUTION` 时，
  服务端把流的前若干 KB 拉下来，在字节流里找分辨率，不需要"进程内解码"。
  HLS 则退一步读第一个分片的流头（`src/resolution.js`）
- **用本机播放器打开流**：浏览器只能拿到 `http(s)` 地址，唤不起本地 exe；
  但**服务端跑在本机**，它 `spawn` 播放器再把地址当参数传进去就行——
  行内 `▶` 只是把地址 POST 给服务端（`/api/open`）

所以这套东西是"网页 UI + 本机服务"，不是桌面应用，也不用打包分发。

## 浏览器兼容

前端不依赖任何 Chromium 专属 API（`fetch` + 自绘弹窗 + 原生 `<input>`），
**Chrome / Edge / Firefox / Safari 都能用**，界面交互上有一处按能力分支：

- **Safari / iOS**：`<video>` 认 `application/vnd.apple.mpegurl`，行内 `▶` 直接在页面里弹窗播
- **其余浏览器**：桌面版 Chrome / Edge / Firefox 都不认原生 HLS（得引 hls.js，本项目零依赖不引），
  行内 `▶` 走本机播放器；万一 `<video>` 仍然报错，页面会自动退回本机播放器，不让你对着黑屏发呆
- **剪贴板**：`navigator.clipboard` 只在安全上下文可用（`localhost` 算，局域网 `http://` 不算），
  所以留了 `execCommand` 兜底，局域网打开时复制照样能用

## 与现有 m3u 编辑器的差异

现有工具（m3u.codes 等）能编辑，但**保存时会把厂商私有属性丢掉**——
`response-time`、`catchup`、`catchup-source`、`timeshift` 这些都不在标准 EXTINF 里，
重序列化时只挑认识的字段写回，导致再保存一次供应商给的列表就废了。

本项目守一条规则：**编辑多少、导出多少，丢不掉的原文**。

具体做法（`src/m3u.js`）：每个 `parseExtinf` 除了解出 `attrMap` 之外，还把每个属性的
**原始 token**（`raw`）连同顺序一起记住，序列化时按原样拼回去，所以：

- 界面上看不见的 `response-time` / `catchup` / `catchup-source` / `timeshift` 等私有属性**原样带出**，
  连双引号、单引号、无引号、`response-time={18}ms` 这种私有裸写法都不动
- 文件头注释（`#KODIPROP`）、频道之间的注释、末尾注释、CRLF 行尾、末尾换行、UTF-8 BOM 都逐字节还原，
  「读一份 → 编辑一轮 → 导出/保存」是幂等的（改动只在你真正动过的那几行）
- 文件头只认整行一句的 `#EXTM3U`；`#EXTM3U-TAIL:...` 这类同前缀行按普通注释处理，不会把真文件头顶掉

编码这块（**读认编码、吐统一 UTF-8**）：读的时候自动识别 UTF-8 / GB18030 / Latin-1；
写的时候一律 UTF-8，行尾和 BOM 沿用原文件。导出时再按后缀分开对待——
`.m3u8` 按 RFC 8216（明文必须 UTF-8、不得带 BOM）**去掉 BOM**，`.m3u` 那套 Winamp 时代
的事实标准没这条规矩，原文件带 BOM 就照旧带出去（覆盖保存同样保留）。MIME 也一并按后缀给：
`.m3u` 是 `audio/x-mpegURL`，`.m3u8` 才是 Safari / iOS 原生播放器认的 `application/vnd.apple.mpegurl`。

## 功能

- **中英双语界面**：顶栏一个按钮就能切（选择记在 localStorage，下次打开还是它）；
  浏览器/系统语言不是简体或繁体中文时**默认英文**。实现上中文就是默认文案（`src/` 的后端日志不参与），
  只额外维护一份英文表 —— 漏翻了照常显示中文，不会出现空白按钮。
  `npm run test:i18n` 会守住这条线：新加的中文没配英文、或者中英占位符 `{n}` 对不齐，测试直接红
- 打开本地文件 / 按绝对路径读取 / 从网址载入 / 拖入文件 / 粘贴文本
- 表格展示：频道名、分组、tvg-id、LOGO、流地址、分辨率、延迟、吞吐、在线状态
- 多选（勾选 / Ctrl / Shift / 全选 / 按分组选）、拖拽排序、行内编辑、新增频道
- 批量改分组、批量删除、按组筛选、搜索
- **批量测速探测**：并发探测，SSE 流式回报；识别 HLS 主播放列表并解析 RESOLUTION / BANDWIDTH
  → 归约为 480p/720p/1080p；测 DNS/TCP/TTFB/总耗时 + 首段吞吐；给出卡顿风险预判
- 探测失败自动勾选（末了只刷新这些行的选中态，不重建表格，光标不丢、不跳行），可一键「清除选择」；
  探测完成会告诉你是哪几条被自动勾上了
- **分辨率补全**：源站漏写 `RESOLUTION` 时（直连流、HLS 子清单都常见）**读视频流头**补齐——
  拉流头若干 KB，按格式走：
  - 直连 **MPEG-TS**：从 TS 包里找 PAT/PMT → 视频 PID → PES 里的 **SPS**，解 `width/height`
    （按 profile / crop 修正真实显示尺寸，不直接拿宏块数）
  - **HEVC 等没带 SPS 的码流**读不出来——强行猜只会写错数，宁可留空并在 tooltip 里说明"源站没给"
  - **直播小窗口也会等**：像 CGTN 那种只留 6 个 4 秒分片（共 24 秒）的，从读到清单再到请求分片
    哪怕只差几百毫秒，清单上列的第一条就 404 了。所以首分片取不到会**重拉一次清单再试一轮**；
    两轮都失败就把 note 改成「分片取不到（404），分辨率读不到」，不再甩一句
    "子清单里不含分辨率信息"让你以为又是源站没给
  - **MP4 / fMP4**：读 `moov > trak > mdia > minf > stbl > stsd` 里视觉样本项的宽高
  - **HLS 子清单**：子清单自己不写分辨率时，读**第一个分片的流头**再补一次
  补出来的分辨率同样参与归档（720p / 1080p…），并可在探测结果的 tooltip 里看到
  「分辨率读自视频流头」之类出处；实在读不出来的频道保持原样，不瞎猜
- **用本机播放器打开流**：扫本机已装的 **VLC / mpv / PotPlayer / MPC-HC / Kodi / 系统默认程序**，
  工具栏「播放器设置」可挑一个或手填任意 exe 路径，也可以点旁边的 **「浏览…」** 直接用鼠标挑
  （浏览器给不出 exe 的真实路径，只会给 `C:\fakepath\xx.exe`，所以浏览由本机服务代劳，
  见 `/api/browse`：只列目录和可执行后缀，不读文件内容；路径框里已经填着某条 exe 时，
  直接从它所在的目录开始列，不会让人先手动退上一级）。
  「浏览」里有**盘符按钮**（`C:` `D:` …）和**直接敲路径**的输入框——到盘符根时「上一级」会失效
  （`C:\` 的父目录还是 `C:\`），跨盘得靠这两个；并且**记住上次逛到哪个目录**，
  下次打开直接从那儿开始，不用每次从 C 盘重头翻。
  选完会记住——**主存在 `~/.iptv-playlist-master.json`，刷新页面、重开浏览器都还在**；
  那份写不进去（只读环境）时自动退到 localStorage，不至于刷新一次就丢。
  浏览器原生支持 HLS 时（Safari / iOS）行内 `▶` 会直接在页面里弹窗播，不去开本机播放器；
  其余浏览器（Chrome / Edge / Firefox 桌面版都不认 `application/vnd.apple.mpegurl`，
  真播还得靠 hls.js 这类库，本项目零依赖不引）就走本机播放器。
  列表里只给**真的存在**的执行文件——别的系统的安装路径（比如 Windows 上出现 `/Applications/VLC.app/...`）
  不算"扫到了"，宁可列表空着让你手填，也好过点一下才蹦"路径不存在"。
  挑定之后表格每行出现 `▶`，点一下就用它开**这一条**流。
  **一个窗口管到底**（刻意*不*做多窗口）：勾选多条（或什么都不选＝整表）后，
  按钮变成「▶ 排进一个窗口 (N)」，N 条一起交给**同一个**播放器进程：
  先落一份临时播放清单（频道名写进 `#EXTINF`），VLC 按列表一条一条播，一个窗口一次只出一路声，
  不会几路声音混成一团。之后**再点**也会继续往**那一个窗口**里加（VLC 自带 HTTP 控制口，
  随机端口 + 随机密码，只听本机回环），桌面始终只留一个 VLC；
  关掉那个窗口后下次点会自动重开（别的播放器没有这个口，就照旧每次起一个实例）。
  超过 50 条会先问一句再排。
  （VLC 的 `--one-instance` 在这台便携版上**实测不转发**——连点三次会起三个进程，所以没指望它。）
  「只听见声音、看不见画面」是 Windows 的**前台激活限制**：服务进程自己没有窗口，
  spawn 出来的播放器窗口只会被丢在浏览器后面（声音照放、画面全被盖住，
  任务栏右侧只剩 VLC 自己的托盘图标），而后台进程调 `SetForegroundWindow` 会被系统直接拒掉。
  所以：spawn 完会按 pid 尽力还原 + 置前（走 PowerShell 调 user32，失败静默跳过），
  工具栏下方还会冒出一条 **「把播放器窗口调到最前」** —— 用户亲手点一下鼠标，
  前台权限才真的松开，这一次多半成；再不行就双击 VLC 托盘图标（官方的恢复方式）。
  窗口位置 VLC 自己记得（也会沿用上次的），被浏览器盖住就点上面那条提示捞回来。
  注意：这条只对**本项目起的那一个** VLC 有效；你自己另开一个 VLC 窗口，那当然是两个。
  **不做"直接相信系统默认播放器"**——系统默认关联经常是浏览器，浏览器打开直播流只会卡在缓冲，
  所以这里是"扫到哪些 + 你亲自选一个"，选中结果记在 localStorage 里
- **回填分辨率 / 回填延迟 / 彻底清洗** —— 三个互相独立的动作：
  - `回填分辨率`：把探测到的档位写回频道名，名字里已经写着别的档位就**就地替换**
    （哪怕被延迟后缀隔在中间，也不会叠成两个）；没探测出分辨率的频道一个字都不动
  - `回填延迟`：把 TTFB 写进频道名末尾，方便同名多源挑低延迟
  - `彻底清洗频道名`：只做减法，分辨率 / 延迟后缀全部摘掉，一个字都不回填
  - `同名按延迟排序`：只挪位置不改名字
- **流地址独立一列**：默认窄列截断（长地址会把表格撑歪），勾「完整地址」整段换行铺开；
  每行 `⧉` 一键复制单条，工具栏「复制地址」把所选频道一行一个批量复制，直接贴进第三方播放器
- **缺 LOGO 也能补**：没 `tvg-logo` 或图加载不出来（onerror 会降级）的行，LOGO 列就地显示 `[+]`，
  点开填图片地址并带实时预览，写进 `tvg-logo` 后只刷这一行，不动整表；留空表示去掉 LOGO
- **从源站更新（Updater）**：拉远端最新列表与本地这张表**合并**——
  匹配按 `tvg-id` → 频道名（空白 / 大小写归一化）；**本地手改过的地址 / 频道名 / LOGO 一律不覆盖**，
  只让远端补本地没有或还旧的部分（LOGO 缺则补、分组只补空）；远端新增的频道默认追加，
  远端删掉的默认保留，勾了「删除已移除」才删。合并结果保留已有探测结果
- 覆盖保存原文件 / 导出 .m3u 与 .m3u8 / 导出任意文件名

## 探测指标说明

延迟用 TTFB（发请求到收到首字节），**不是 ping**。ICMP 走独立路径，8ms 低延迟照样可能卡顿，
所以延迟只当参考值；真正判断卡顿看的是带宽是否够（例如 1080p 需要 ≥ 8Mbps 左右）。

## 判定「在线」的容错

一次性 120 条并发探测，误判死链几乎都来自抖动而不是源真的死了，所以探测带三层容错：

1. **瞬时故障自动重试**：超时 / ECONNRESET / DNS 临时失败 / 5xx / 429 自动重试，最多共 3 次尝试，
   退避 300ms 起、带随机抖动；失败时状态列的 tooltip 会写明「共尝试 N 次（重试 M 次仍失败）」
2. **403 换播放器 UA 重试**：不少 IPTV 源站只放行播放器 UA，换一次再试；成了会注明「换播放器 UA 后放行」
3. **同域名串行闸门**：同源请求之间至少隔 0.2 秒（同一时刻只放行一个），避免把自己的并发打到限流

域名不存在、HTTP 404 这类永久错误不重试，白等没有意义。证书类错误仍然只走「跳过证书校验」那一次机会，
两条路都不再承诺「播放器通常仍能播」——能不能播得你自己拿 VLC 试。

## 目录

```
src/m3u.js      解析 / 序列化（无损往返，保留私有属性）
src/probe.js    流探测（DNS/TCP/TTFB/吞吐、HLS 变体解析、卡顿预判）
src/resolution.js  从 TS / MP4 / HLS 首分片流头里读分辨率
src/player.js   本机播放器扫描 + 打开流（服务端 spawn）
src/merge.js    源站合并更新（本地手改字段不被覆盖）
src/suffix.js   频道名后缀的摘 / 写（无损，不静默丢信息）
src/sort.js     同名频道按延迟排序
src/server.js   零依赖 HTTP 服务 + SSE 流式探测
public/         前端表格（app.js） + i18n 中英字典（i18n.js）
sample/         样例列表（含多种私有写法与失效地址）
test/           测试
```

## 编码

读文件时按 utf-8 → gb18030 → latin1 依次试解码。非 UTF-8 列表保存/导出时会统一输出为 UTF-8，
界面顶部会给出提示，不会静默改数据。
