# QQMusic API for Node.js

> **注意**：本项目仅用于技术研究与学习，请勿用于侵犯版权或其他商业用途，请支持正版音乐。

## ✨ 特性

### 核心库

- **核心客户端** `Client`：封装 HTTP 请求、User-Agent、Cookie、Session、QIMEI 设备指纹
- **请求描述符** `Request`：实现 thenable，可直接 `await`，也支持 `gather` 批量并发
- **签名算法**：`zzc_sign` 签名、自定义 TripleDES 加解密、QRC 歌词解密
- **业务模块**：`search` / `song` / `user` / `login`
- **多平台支持**：Android / Desktop / Web 三种平台版本策略
- **凭证自动保活**：musickey 剩余有效期不足时自动续期，请求撞上过期码自动刷新重放

### Web UI（内置，移动端适配）

- **搜索**：歌名/歌手/专辑/歌单快速搜索、热搜榜、输入联想补全、分页
- **歌单**：disstid/链接直接载入、按 QQ 号浏览收藏歌单、批量勾选操作
- **链接解析**：粘贴歌曲链接/songmid，逐项探测 17 种音质可用性（含下载直链）
- **歌词**：QRC/LRC 解析、原文/翻译/音译切换、滚动歌词、歌词偏移微调、点词跳播
- **在线播放**（[APlayer](https://aplayer.js.org/)）：搜索/歌单行内播放、播放历史
- **播放列表**（持久化）：歌曲行 ＋ 一键加入；顺序/列表循环/单曲循环/随机四种模式；
  自动续播（预取下一首直链）、断链自愈（重取重试）、死曲自动跳过；拖拽排序；
  整单加入下载队列
- **下载**：浏览器代理下载（并发上限可调）或 aria2 RPC 直发；下载队列支持暂停/清空
- **站点功能**：公告弹窗（支持强制阅读倒计时）、联系方式卡片、暗/亮主题切换

### 登录管理（`/login`）

- QQ 二维码登录、手机验证码登录、当前用户信息
- 凭证管理：查看状态、手动刷新、替换凭证 JSON、登出
- 公告与联系方式的在线配置
- 管理员密钥：默认 `123456`，首次使用强制修改（仅存 sha256 哈希）

## 📦 安装

```bash
cd QQMusicapi
npm install
```

要求 Node.js >= 18。

## 🚀 快速开始

### 启动 Web 服务

```bash
# 默认监听 3300 端口
npm start

# 开发模式
npm run dev

# 自定义端口与设备路径
PORT=3000 DEVICE_PATH=./device.json npm start
```

启动后访问：

- **首页**：[http://localhost:3300/](http://localhost:3300/) — 搜索下载 / 歌单浏览 / 链接解析三个页签，集成播放列表与 APlayer 在线试听（移动端自动切换为底部迷你播放器布局）
- **登录管理**：[http://localhost:3300/login](http://localhost:3300/login) — QQ 二维码/手机验证码登录、凭证管理、公告与联系方式配置（需管理员密钥）

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3300` | 监听端口 |
| `DEVICE_PATH` | `./device.json` | 设备信息持久化路径 |
| `CREDENTIAL_PATH` | `./credential.json` | 凭证持久化路径 |
| `PLATFORM` | `android` | 请求平台：`android` / `desktop` / `web` |
| `QQMUSIC_DEBUG` | - | 设为 `1` 时输出 check_sig 等调试日志 |
| `ADMIN_KEY` | - | 管理员密钥（推荐部署时设置；设置后不可从 UI 修改） |
| `ADMIN_BOOTSTRAP_KEY` | `123456` | 未配置 `ADMIN_KEY` 时的引导默认密钥，首次使用强制修改 |
| `AUTH_PATH` | `./auth.json` | 从 UI 修改密钥后的哈希存储路径（仅存 sha256） |
| `CREDENTIAL_KEEP_INTERVAL` | `21600000` | 凭证保活巡检间隔（毫秒，默认 6 小时） |
| `CREDENTIAL_REFRESH_AHEAD` | `86400` | musickey 剩余有效期低于该秒数时提前续期（默认 24 小时） |
| `MAX_CONCURRENT_DOWNLOADS` | `4` | 下载代理并发上限 |

### 管理员密钥

管理接口（`/login/*`、`/user/follow`、`/user/self`、`/site/admin`、`PUT /site` 等）需要管理员密钥，可通过 `X-API-Key` 头、`?key=` 查询参数或 body 中的 `key` 字段提供。

密钥解析顺序：

1. `ADMIN_KEY` 环境变量（部署者管理，UI 不可修改）；
2. `auth.json` 中的哈希（从主页/登录页修改默认密钥后写入，仅存 sha256）；
3. 引导默认密钥 `ADMIN_BOOTSTRAP_KEY`（默认 `123456`）。

使用引导默认密钥时，进入首页或登录管理页会弹出**不可跳过的改密窗口**，且除改密接口外的所有管理接口返回 `403`（`code=40301`），直至密钥修改完成。`GET /auth/status` 可查询当前密钥来源（`env` / `file` / `bootstrap`）与是否待修改。

## 🌐 Web API

### 通用约定

- 所有响应均为 JSON，格式：`{ code, message, data, meta? }`
- `code === 0` 表示成功，非零表示失败
- POST 请求使用 `application/json` body

### 路由列表

#### 基础

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/` | GET | 首页 Web UI（歌曲解析器） |
| `/login` | GET | 登录管理 Web UI |
| `/health` | GET | 健康检查（含凭证过期字段） |
| `/auth/status` | GET | 管理员密钥状态（来源 / 是否需修改 / keyValid） |
| `/auth/change-key` | POST | 修改管理员密钥（`{currentKey, newKey}`，新密钥至少 8 位） |

#### 搜索 `/search`

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/search/hotkey` | GET | 热搜词 |
| `/search/complete?keyword=...` | GET | 搜索补全 |
| `/search/quick?keyword=...` | GET | 快速搜索 |
| `/search/general` | POST | 综合搜索 |
| `/search/byType` | POST | 按类型搜索 |

#### 歌曲 `/song`

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/song/detail?mids=a,b` | GET | 歌曲详情 |
| `/song/urls?mids=a,b&type=MP3_128` | GET | 播放直链（支持 17 种音质） |
| `/song/lyric?mid=...&decode=1` | GET | 歌词（自动 QRC 解密） |
| `/song/similar?songid=...` | GET | 相似歌曲 |
| `/song/relatedSonglist?mid=...` | GET | 相关歌单 |

#### 用户 `/user`

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/user/self` | GET | 当前登录用户信息 |
| `/user/info?uin=...` | GET | 指定用户信息 |
| `/user/songlist?uin=...&page=1&num=30` | GET | 用户歌单 |
| `/user/follows?uin=...&page=1&num=30` | GET | 关注列表 |
| `/user/fans?uin=...&page=1&num=30` | GET | 粉丝列表 |
| `/user/follow` | POST | 关注 / 取消关注 |

#### 登录 `/login`

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/login/status` | GET | 凭证状态 |
| `/login/credential` | GET | 查看凭证（脱敏） |
| `/login/credential` | PUT | 替换凭证 |
| `/login/credential` | DELETE | 清空凭证 |
| `/login/refresh` | POST | 刷新凭证 |
| `/login/logout` | POST | 登出 |
| `/login/qrcode` | POST | 获取 QQ 登录二维码 |
| `/login/checkQrcode` | POST | 检查二维码状态 |
| `/login/sendAuthcode` | POST | 发送手机验证码 |
| `/login/phone` | POST | 手机验证码登录 |

### 支持的音质

`/song/urls` 接口的 `type` 参数支持以下 17 种音质：

| 代码 | 说明 |
| --- | --- |
| `DT03` | DTS:X |
| `AI00` | 臻品母带 |
| `Q000` | 臻品音质 |
| `Q001` | 臻品全景声 5.1 |
| `Q003` | 臻品全景声 7.1 |
| `D004` | 杜比全景声 |
| `TL01` | AICodec |
| `F000` | SQ 无损 |
| `O801` | OGG 640 |
| `O800` | OGG 320 |
| `O600` | OGG 192 |
| `O400` | OGG 96 |
| `M800` | MP3 320 |
| `M500` | MP3 128 |
| `C600` | ACC 192 |
| `C400` | ACC 96 |
| `C200` | ACC 48 |

## 🖥️ Web UI

### 首页 (`/`)

三个页签：**搜索下载** / **歌单** / **链接解析**，右侧（移动端为底部迷你播放器）为常驻播放器区。

- **搜索下载**：关键词搜索、热搜、输入联想；结果行内按钮：下载 / 播放 / 解析 / ＋加入播放列表；勾选后可批量"添加到下载队列"或"加入播放列表"
- **歌单**：粘贴 disstid/链接载入，或输入 QQ 号浏览收藏歌单；支持"全部加入播放列表"
- **链接解析**：粘贴歌曲链接或 songmid，并发获取 17 种音质直链并显示可用/不可用状态；歌词多版本切换（原文/翻译/罗马音）；相似歌曲推荐
- **播放列表**（右侧面板，移动端在展开的底部播放器中）：
  - 持久化保存（localStorage），刷新/重开不丢
  - 四种播放模式：顺序（播完停止）/ 列表循环 / 单曲循环 / 随机
  - 可持续播放：自动续播时预取下一首直链；直链失效自动重取重试一次，仍失败自动跳过；连续多首失败自动暂停
  - 拖拽排序（PC）、逐条移除、一键清空、整单加入下载队列
- **播放历史**：最近 100 首（保留一周），点击即回放
- **歌词**：滚动歌词、偏移微调（±0.1s）、点词跳播

### 登录管理 (`/login`)

- **当前登录状态**：展示登录态、musicid、凭证过期标志、凭证文件路径
- **当前用户信息**：头像、昵称
- **QQ 二维码登录**：实时轮询扫码状态（SCAN / CONF / DONE / REFUSE / TIMEOUT）
- **手机验证码登录**：发送验证码（60s 倒计时）并登录
- **凭证管理**：刷新凭证、退出登录
- **站点配置**：公告（标题/正文/强制阅读秒数）与联系方式（个人/群组卡片）
- **管理员密钥**：默认 `123456` 首次强制修改

## 🔭 后续规划

见 [ROADMAP.md](./ROADMAP.md)（下一步优化方案）。

## 📁 项目结构

```
src/
├── algorithms/          # 签名与加解密算法
│   ├── sign.js          # zzc_sign 签名
│   ├── tripledes.js     # TripleDES 加解密
│   └── qrc.js           # QRC 歌词解密
├── models/              # 数据模型
│   ├── credential.js    # 登录凭证
│   └── request.js       # 请求描述符 (thenable)
├── modules/             # 业务模块
│   ├── base.js          # 模块基类
│   ├── search.js        # 搜索
│   ├── song.js          # 歌曲
│   ├── song_filetype.js # 音质类型
│   ├── user.js          # 用户
│   └── login.js         # 登录
├── public/              # Web UI 静态资源
│   ├── index.html       # 首页解析器
│   └── login.html       # 登录管理页
├── utils/               # 工具
│   ├── common.js        # 通用工具
│   ├── device.js        # 设备指纹管理
│   └── qimei.js         # QIMEI 注册
├── client.js            # 核心客户端
├── exceptions.js        # 异常定义
├── server.js            # Koa 服务入口
├── version.js           # 版本号
└── versioning.js        # 平台版本策略
```
