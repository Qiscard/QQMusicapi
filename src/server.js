/**
 * QQ Music API - 纯 JS 服务端入口 (Koa).
 *
 * 该文件合并自原 TS 项目的:
 *   - web/app.ts (Koa 应用装配)
 *   - web/server.ts (独立服务启动)
 *   - web/_helpers.ts (ok()/fail()/errorHandler)
 *   - web/credentialStore.ts (凭证文件存储)
 *   - web/routes/search.ts, song.ts, user.ts, login.ts (业务路由)
 *
 * 仅保留 API 路由, 移除静态文件 / Web UI / NO_WEB_UI 开关.
 *
 * 环境变量:
 *   PORT             监听端口 (默认 3300)
 *   DEVICE_PATH      设备信息持久化路径 (默认 ./device.json)
 *   CREDENTIAL_PATH  凭证持久化路径 (默认 ./credential.json)
 *   PLATFORM         请求平台: android / desktop / web (默认 android)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, createReadStream } from "node:fs";
import { dirname, isAbsolute, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, timingSafeEqual } from "node:crypto";
import { request as undiciRequest } from "undici";
import Koa from "koa";
import bodyParser from "koa-bodyparser";
import Router from "@koa/router";

import { Client } from "./client.js";
import { Platform } from "./versioning.js";
import { Credential } from "./models/credential.js";
import { SearchType } from "./modules/search.js";
import { SongFileType, parseSongFileType } from "./modules/song_filetype.js";
import { QrLoginType } from "./modules/login.js";
import { qrcDecrypt } from "./algorithms/qrc.js";

// ==================== 响应辅助 ====================

/** 统一成功响应 */
function ok(data, meta) {
  return { code: 0, message: "ok", data, ...(meta ? { meta } : {}) };
}

/** 统一失败响应 */
function fail(code, message, data) {
  return { code, message, data };
}

/**
 * 将异步路由抛出的异常统一序列化为 JSON.
 */
async function errorHandler(ctx, next) {
  try {
    await next();
  } catch (e) {
    const err = e;
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    ctx.status = status;
    ctx.body = fail(err.code ?? status, err.message || "Internal Server Error", err.data);
    if (status >= 500) {
      console.error("[qqmusic-api]", err);
    }
  }
}

// ==================== 运行配置存储 ====================

/** 音质列表 (code/label/ext), 供 /config 下发与校验.
 * TL01 (AICodec/.nac) 为腾讯私有格式, 本地无法播放, 不对外提供. */
const QUALITY_LIST = Object.getOwnPropertyNames(SongFileType)
  .map((k) => SongFileType[k])
  .filter((v) => v instanceof SongFileType && v.code !== "TL01")
  .map((v) => ({ code: v.code, label: v.label, ext: v.ext }));

/** 默认音质使用 wire code (M500 = MP3 128k); 不要用枚举属性名, 保证与 /song/urls 的 type 一致 */
const DEFAULT_QUALITY = "M500";

/**
 * 运行配置 (config.json). 目前仅 defaultQuality;
 * defaultQuality 可由任意用户在 UI 中修改 (公开接口).
 */
class ConfigStore {
  constructor(options = {}) {
    this._path = options.path
      ? (isAbsolute(options.path) ? options.path : resolve(options.path))
      : resolve("./config.json");
    this._data = this._load();
  }

  get path() {
    return this._path;
  }

  get defaultQuality() {
    return this._data.defaultQuality;
  }

  /** 更新配置并原子写盘; 字段合法性由调用方 (路由) 校验 */
  async update(patch) {
    this._data = { ...this._data, ...patch };
    await this._persist();
    return this._data;
  }

  toPublicJSON() {
    return {
      defaultQuality: this._data.defaultQuality,
      qualities: QUALITY_LIST,
    };
  }

  _load() {
    let data = { defaultQuality: DEFAULT_QUALITY };
    try {
      if (existsSync(this._path)) {
        const raw = JSON.parse(readFileSync(this._path, "utf-8"));
        if (raw && typeof raw === "object") data = { ...data, ...raw };
      }
    } catch {
      // 配置文件损坏时回退默认
    }
    if (!parseSongFileType(data.defaultQuality)) data.defaultQuality = DEFAULT_QUALITY;
    return data;
  }

  async _persist() {
    return new Promise((res, rej) => {
      try {
        const dir = dirname(this._path);
        if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
        const tmp = `${this._path}.tmp`;
        writeFileSync(tmp, JSON.stringify(this._data, null, 2), "utf-8");
        renameSync(tmp, this._path);
        res();
      } catch (e) {
        rej(e);
      }
    });
  }
}

// ==================== 管理员鉴权 ====================

/**
 * 管理员密钥从环境变量 ADMIN_KEY 读取 (绝不写入源码).
 * 未配置时所有管理接口返回 503.
 */
const ADMIN_KEY = String(process.env.ADMIN_KEY ?? "");

/** 常量时间比较 (先哈希对齐长度), 避免时序侧信道 */
function keyMatches(input) {
  if (!ADMIN_KEY || typeof input !== "string" || !input) return false;
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(ADMIN_KEY).digest();
  return timingSafeEqual(a, b);
}

/**
 * 管理员鉴权: 密钥可通过 X-API-Key 头 / ?key= 查询参数 / body.key 提供.
 */
function requireAdmin(ctx) {
  if (keyMatches(ctx.get("x-api-key") ?? "")) return;
  if (keyMatches(String(ctx.query.key ?? ""))) return;
  const bodyKey = ctx.request.body?.key;
  if (typeof bodyKey === "string" && keyMatches(bodyKey)) return;
  if (!ADMIN_KEY) {
    ctx.throw(503, "服务端未配置 ADMIN_KEY 环境变量, 管理功能不可用");
  }
  ctx.throw(401, "需要管理员密钥 (X-API-Key 头或 ?key= 参数)");
}

// ==================== 账号等级探测 ====================

/**
 * QQ 没有公开的 VIP 等级查询接口 (musicu vip 模块已收紧),
 * 这里用行为探测: 对一首确定的 VIP 歌曲实测各音质能否取链.
 * 能取 SVIP 专属音质 -> svip; 能取无损/320 -> vip; 否则 normal.
 * 该结果同时决定 /config 中的可用音质列表 (需求: 按账号等级过滤默认音质).
 */
const ACCOUNT_LEVEL_RANK = { none: 0, normal: 1, vip: 2, svip: 3 };
const PROBE_SONG_MID = "0039MnYb0qxYhV"; // 晴天 - 周杰伦 (VIP 歌曲)
const SVIP_PROBE_CODES = ["Q000", "AI00", "D004"];
const VIP_PROBE_CODES = ["F000", "O801", "M800"];
const ACCOUNT_STATS_TTL = 30 * 60 * 1000;

/**
 * 音质 -> 所需最低账号等级.
 * 分级来自实测 (2026-10, 对 VIP 账号 17 音质全量探测):
 * VIP 可用 TL01/F000/O801/O800/O600/O400/M800/M500/C600/C400/C200,
 * 臻品(Q000/Q001/Q003)/母带(AI00)/杜比(D004)/DTS(DT03) 为 SVIP 专属.
 */
const QUALITY_MIN_LEVEL = {
  M500: "normal", C200: "normal", C400: "normal", C600: "normal", O400: "normal",
  M800: "vip", F000: "vip", O600: "vip", O800: "vip", O801: "vip", TL01: "vip",
  AI00: "svip", Q000: "svip", Q001: "svip", Q003: "svip",
  D004: "svip", DT03: "svip",
};

let accountStatsCache = { ts: 0, level: "unknown", counts: { total: 0, svip: 0, vip: 0, normal: 0 } };
let accountStatsPending = null;

async function probeAccountLevel(client) {
  if (!client.credential.isLoggedIn()) return "none";
  const hasPurl = async (code) => {
    try {
      const urls = await client.song.getPlayUrls([PROBE_SONG_MID], code);
      return Boolean(urls?.[PROBE_SONG_MID]?.url);
    } catch {
      return false;
    }
  };
  for (const code of SVIP_PROBE_CODES) {
    if (await hasPurl(code)) return "svip";
  }
  for (const code of VIP_PROBE_CODES) {
    if (await hasPurl(code)) return "vip";
  }
  return "normal";
}

/** 探测并缓存账号等级; 过期后首个请求会触发重新探测 */
async function getAccountStats(client) {
  if (Date.now() - accountStatsCache.ts < ACCOUNT_STATS_TTL) return accountStatsCache;
  if (accountStatsPending) return accountStatsPending;
  accountStatsPending = (async () => {
    const level = await probeAccountLevel(client);
    const counts = { total: 0, svip: 0, vip: 0, normal: 0 };
    if (level !== "none" && level !== "unknown") {
      counts.total = 1;
      if (level === "svip") counts.svip = 1;
      else if (level === "vip") counts.vip = 1;
      else counts.normal = 1;
    }
    accountStatsCache = { ts: Date.now(), level, counts };
    return accountStatsCache;
  })();
  try {
    return await accountStatsPending;
  } finally {
    accountStatsPending = null;
  }
}

// ==================== 凭证存储 ====================

/**
 * 凭证文件存储.
 * 启动时从文件加载凭证,后续每次更新都原子写入磁盘.
 * 文件格式: JSON, 与 Credential.toJSON() 输出一致.
 */
class CredentialStore {
  constructor(options = {}) {
    this._path = options.path
      ? isAbsolute(options.path)
        ? options.path
        : resolve(options.path)
      : resolve("./credential.json");
    this._credential = this._load();
    this._writeQueue = Promise.resolve();
  }

  /** 当前凭证的引用(外部修改不会自动落盘, 请使用 replace) */
  get credential() {
    return this._credential;
  }

  /** 凭证文件路径 */
  get path() {
    return this._path;
  }

  /** 替换当前凭证并原子写入文件 */
  async replace(credential) {
    const next = credential instanceof Credential ? credential : new Credential(credential);
    this._credential = next;
    await this._persist();
    return next;
  }

  /** 与现有凭证合并并写入 */
  async merge(patch) {
    const merged = new Credential({ ...this._credential.toJSON(), ...patch });
    this._credential = merged;
    await this._persist();
    return merged;
  }

  /** 清空凭证 (仅清除 musickey/musicid, 保留 device) */
  async clear() {
    this._credential = new Credential();
    await this._persist();
  }

  /** 返回脱敏后的凭证(用于前端展示,隐藏 musickey/openid 等敏感字段) */
  toSafeJSON(includeSensitive = false) {
    const raw = this._credential.toJSON();
    if (includeSensitive) return raw;
    const safe = {};
    for (const [k, v] of Object.entries(raw)) {
      if (this._isSensitive(k)) {
        safe[k] = v ? "***" : "";
      } else {
        safe[k] = v;
      }
    }
    return safe;
  }

  _isSensitive(key) {
    return [
      "musickey",
      "openid",
      "unionid",
      "accessToken",
      "refreshToken",
      "refreshKey",
      "encryptUin",
    ].includes(key);
  }

  _load() {
    if (!existsSync(this._path)) return new Credential();
    try {
      const raw = JSON.parse(readFileSync(this._path, "utf-8"));
      return new Credential(raw);
    } catch {
      return new Credential();
    }
  }

  async _persist() {
    // 串行化写操作, 避免并发覆盖
    this._writeQueue = this._writeQueue.then(() => this._doWrite());
    await this._writeQueue;
  }

  _doWrite() {
    return new Promise((resolve, reject) => {
      try {
        const dir = dirname(this._path);
        if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
        const tmp = `${this._path}.tmp`;
        const json = JSON.stringify(this._credential.toJSON(), null, 2);
        writeFileSync(tmp, json, "utf-8");
        renameSync(tmp, this._path);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }
}

// ==================== 路由: /search ====================

function searchRouter(client) {
  const router = new Router({ prefix: "/search" });

  router.get("/hotkey", async (ctx) => {
    ctx.body = ok(await client.search.getHotkey());
  });

  router.get("/complete", async (ctx) => {
    const keyword = String(ctx.query.keyword ?? "");
    if (!keyword) ctx.throw(400, "keyword 必填");
    ctx.body = ok(await client.search.complete(keyword));
  });

  router.get("/quick", async (ctx) => {
    const keyword = String(ctx.query.keyword ?? "");
    if (!keyword) ctx.throw(400, "keyword 必填");
    ctx.body = ok(await client.search.quickSearch(keyword));
  });

  router.post("/general", async (ctx) => {
    const body = ctx.request.body ?? {};
    const { keyword, page, num, searchid, pageStart, highlight } = body;
    if (!keyword) ctx.throw(400, "keyword 必填");
    ctx.body = ok(
      await client.search.generalSearch(
        keyword,
        page ?? 1,
        num ?? 15,
        searchid ?? null,
        pageStart ?? null,
        highlight ?? true,
      ),
    );
  });

  router.post("/byType", async (ctx) => {
    const body = ctx.request.body ?? {};
    const { keyword, type, num, page, searchid, highlight } = body;
    if (!keyword) ctx.throw(400, "keyword 必填");
    ctx.body = ok(
      await client.search.searchByType(
        keyword,
        type ?? SearchType.SONG,
        num ?? 10,
        page ?? 1,
        searchid ?? null,
        highlight ?? true,
      ),
    );
  });

  return router;
}

// ==================== 下载代理 ====================

/** CDN 域名白名单: 仅允许 *.qq.com (isure/stream/aqqmusic 等均为其子域) */
const QQ_CDN_HOST_RE = /(^|\.)qq\.com$/i;

function sanitizeFilename(s) {
  return String(s ?? "")
    .replace(/[\\/:*?"<>|\r\n\0]/g, "_")
    .trim();
}

/**
 * 将播放直链以附件形式流式转发给客户端 (带 Content-Disposition 文件名).
 * 直链来自 GetVkey 响应, 仍校验协议 (仅 http/https) 与域名白名单.
 */
async function streamDownload(ctx, url, { name, singer, ext }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    ctx.throw(502, "播放直链解析失败");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    ctx.throw(502, `不允许的直链协议: ${parsed.protocol}`);
  }
  if (!QQ_CDN_HOST_RE.test(parsed.hostname)) {
    ctx.throw(502, `直链域名不在白名单: ${parsed.hostname}`);
  }
  const upstream = await undiciRequest(url, {
    method: "GET",
    headers: { "User-Agent": "QQMusic" },
    maxRedirections: 5,
  });
  if (upstream.statusCode !== 200) {
    upstream.body?.destroy?.();
    ctx.throw(502, `CDN 返回 HTTP ${upstream.statusCode}`);
  }
  const base =
    [sanitizeFilename(singer), sanitizeFilename(name)].filter(Boolean).join(" - ") ||
    `qqmusic_${Date.now()}`;
  const filename = `${base}${ext || ".mp3"}`;
  ctx.status = 200;
  ctx.set(
    "Content-Type",
    upstream.headers["content-type"] ?? "application/octet-stream",
  );
  const len = upstream.headers["content-length"];
  if (len) ctx.set("Content-Length", len);
  ctx.set(
    "Content-Disposition",
    `attachment; filename="download${ext || ".mp3"}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  // undici 的 res.body (BodyReadable) 本身就是 Node Readable, Koa 可直接消费
  ctx.body = upstream.body;
}

// ==================== 路由: /song ====================

function songRouter(client, configStore) {
  const router = new Router({ prefix: "/song" });

  router.get("/detail", async (ctx) => {
    const mids = String(ctx.query.mids ?? "").split(",").filter(Boolean);
    if (mids.length === 0) ctx.throw(400, "mids 必填");
    ctx.body = ok(await client.song.getDetail(mids));
  });

  router.get("/urls", async (ctx) => {
    const mids = String(ctx.query.mids ?? "").split(",").filter(Boolean);
    if (mids.length === 0) ctx.throw(400, "mids 必填");
    const typeStr = String(ctx.query.type ?? "MP3_128");
    const fileType = parseSongFileType(typeStr) ?? typeStr;
    ctx.body = ok(await client.song.getPlayUrls(mids, fileType));
  });

  router.get("/lyric", async (ctx) => {
    const mid = String(ctx.query.mid ?? "");
    if (!mid) ctx.throw(400, "mid 必填");
    const wantDecode = String(ctx.query.decode ?? "1") !== "0";
    const data = await client.song.getLyrics(mid, { trans: true, roma: false, qrc: true });
    const out = { raw: data };
    if (wantDecode) {
      try {
        if (data.crypt === 1) {
          if (data.lyric) out.lyric = qrcDecrypt(data.lyric);
          if (data.trans) out.trans = qrcDecrypt(data.trans);
          if (data.roma) out.roma = qrcDecrypt(data.roma);
        } else {
          // 后端未加密, 直接透传
          out.lyric = data.lyric ?? "";
          out.trans = data.trans ?? "";
          out.roma = data.roma ?? "";
        }
      } catch (e) {
        out.decodeError = `QRC 解密失败: ${e.message}`;
      }
    }
    ctx.body = ok(out);
  });

  router.get("/similar", async (ctx) => {
    const songid = ctx.query.songid ?? ctx.query.id;
    if (!songid) ctx.throw(400, "songid 必填 (数字歌曲 ID)");
    const data = await client.song.getSimilar(String(songid));
    // 展开: 把 [group.songs[].track] 展平成一维数组
    const list = [];
    for (const group of data?.vecSongNew ?? []) {
      for (const entry of group.songs ?? []) {
        if (entry?.track) list.push(entry.track);
      }
    }
    ctx.body = ok({ list, groups: data?.vecSongNew ?? [] });
  });

  router.get("/relatedSonglist", async (ctx) => {
    const mid = String(ctx.query.mid ?? "");
    if (!mid) ctx.throw(400, "mid 必填");
    ctx.body = ok(await client.song.getRelatedSonglist(mid));
  });

  // 下载代理: 流式转发并带文件名; type 缺省取全局默认音质
  router.get("/download", async (ctx) => {
    const mid = String(ctx.query.mid ?? "").trim();
    if (!mid) ctx.throw(400, "mid 必填");
    const q = parseSongFileType(String(ctx.query.type ?? "")) ?? null;
    const typeStr = q ? q.code : configStore.defaultQuality;
    const fileType = q ?? typeStr;
    const urls = await client.song.getPlayUrls([mid], fileType);
    const info = urls[mid];
    if (!info?.url) ctx.throw(502, info?.error || "无可用直链");
    let name = ctx.query.name;
    let singer = ctx.query.singer;
    if (!name) {
      try {
        const detail = await client.song.getDetail([mid]);
        const t = detail?.tracks?.[0];
        if (t) {
          name = t.name;
          singer = singer ?? (t.singer ?? []).map((s) => s.name).join(" / ");
        }
      } catch {
        // 详情失败不影响下载
      }
    }
    await streamDownload(ctx, info.url, {
      name,
      singer,
      ext: parseSongFileType(typeStr)?.ext,
    });
  });

  return router;
}

// ==================== 路由: /user ====================

function userRouter(client) {
  const router = new Router({ prefix: "/user" });

  router.get("/self", async (ctx) => {
    ctx.body = ok(await client.user.getSelfInfo());
  });

  router.get("/info", async (ctx) => {
    const uin = String(ctx.query.uin ?? "");
    if (!uin) ctx.throw(400, "uin 必填");
    ctx.body = ok(await client.user.getUserInfo(uin));
  });

  router.get("/songlist", async (ctx) => {
    const uin = String(ctx.query.uin ?? "");
    if (!uin) ctx.throw(400, "uin 必填");
    const page = Number(ctx.query.page ?? 1);
    const num = Number(ctx.query.num ?? 30);
    ctx.body = ok(await client.user.getUserSonglist(uin, page, num));
  });

  router.get("/follows", async (ctx) => {
    const uin = String(ctx.query.uin ?? "");
    if (!uin) ctx.throw(400, "uin 必填");
    const page = Number(ctx.query.page ?? 1);
    const num = Number(ctx.query.num ?? 30);
    ctx.body = ok(await client.user.getUserFollows(uin, page, num));
  });

  router.get("/fans", async (ctx) => {
    const uin = String(ctx.query.uin ?? "");
    if (!uin) ctx.throw(400, "uin 必填");
    const page = Number(ctx.query.page ?? 1);
    const num = Number(ctx.query.num ?? 30);
    ctx.body = ok(await client.user.getUserFans(uin, page, num));
  });

  router.post("/follow", async (ctx) => {
    requireAdmin(ctx); // 关注操作影响登录账号, 需管理员密钥
    const body = ctx.request.body ?? {};
    const uin = String(body.uin ?? "");
    const follow = Boolean(body.follow ?? true);
    if (!uin) ctx.throw(400, "uin 必填");
    ctx.body = ok(await client.user.follow(uin, follow));
  });

  return router;
}

// ==================== 路由: /login ====================

function loginRouter(client, store) {
  const router = new Router({ prefix: "/login" });

  // 管理员鉴权: 登录/凭证管理必须持密钥访问
  router.use(async (ctx, next) => {
    requireAdmin(ctx);
    await next();
  });

  /** 同步内存凭证与 store (启动时已加载, 这里只保证运行时一致) */
  const syncClient = () => {
    client.credential = store.credential;
  };

  router.get("/status", async (ctx) => {
    const expired = store.credential.musickey
      ? await client.login.checkExpired(store.credential)
      : false;
    ctx.body = ok({
      loggedIn: store.credential.isLoggedIn(),
      expired,
      musicid: store.credential.musicid || null,
      file: store.path,
    });
  });

  router.get("/credential", async (ctx) => {
    const includeSensitive = String(ctx.query.raw ?? "") === "1";
    ctx.body = ok({
      credential: store.toSafeJSON(includeSensitive),
      file: store.path,
    });
  });

  router.put("/credential", async (ctx) => {
    const body = ctx.request.body ?? {};
    const saved = await store.replace(body);
    syncClient();
    ctx.body = ok(saved.toJSON());
  });

  router.delete("/credential", async (ctx) => {
    await store.clear();
    syncClient();
    ctx.body = ok({ ok: true });
  });

  router.post("/refresh", async (ctx) => {
    const newCred = await client.login.refreshCredential(store.credential);
    await store.replace(newCred);
    syncClient();
    ctx.body = ok(newCred.toJSON());
  });

  router.post("/logout", async (ctx) => {
    try {
      await client.login.logout(store.credential);
    } catch {
      // 即使服务端登出失败也允许本地清空
    }
    await store.clear();
    syncClient();
    ctx.body = ok({ ok: true });
  });

  router.post("/qrcode", async (ctx) => {
    const body = ctx.request.body ?? {};
    const typeStr = String(body.type ?? "qq");
    const type = typeStr === "wx" ? QrLoginType.WX : typeStr === "mobile" ? QrLoginType.MOBILE : QrLoginType.QQ;
    const qr = await client.login.getQrcode(type);
    ctx.body = ok({
      type: qr.type,
      mime: qr.mime,
      identifier: qr.identifier,
      // 返回 base64 便于前端展示
      data: qr.data.toString("base64"),
    });
  });

  router.post("/checkQrcode", async (ctx) => {
    const body = ctx.request.body ?? {};
    const identifier = String(body.identifier ?? "");
    const type = String(body.type ?? "qq");
    if (!identifier) ctx.throw(400, "identifier 必填");
    const result = await client.login.checkQrcode({
      identifier,
      type: type === "wx" ? QrLoginType.WX : QrLoginType.QQ,
      data: Buffer.alloc(0),
      mime: "",
    });
    let saved = null;
    if (result.credential) {
      await store.replace(result.credential);
      syncClient();
      saved = result.credential.toJSON();
    }
    ctx.body = ok({
      event: result.event,
      credential: saved,
    });
  });

  router.post("/sendAuthcode", async (ctx) => {
    const body = ctx.request.body ?? {};
    const phone = body.phone;
    const countryCode = Number(body.countryCode ?? 86);
    if (phone === undefined) ctx.throw(400, "phone 必填");
    ctx.body = ok(await client.login.sendAuthcode(phone, countryCode));
  });

  router.post("/phone", async (ctx) => {
    const body = ctx.request.body ?? {};
    const phone = body.phone;
    const code = String(body.code ?? "");
    if (phone === undefined || !code) ctx.throw(400, "phone 和 code 必填");
    const cred = await client.login.phoneAuthorize(phone, code);
    await store.replace(cred);
    syncClient();
    ctx.body = ok(cred.toJSON());
  });

  return router;
}

// ==================== 路由: 歌单/专辑/歌手 ====================

function mediaRouter(client) {
  const router = new Router();

  /** 歌单内歌曲列表 (公开歌单匿名可读, 登录后可读私有歌单) */
  router.get("/songlist/tracks", async (ctx) => {
    const disstid = ctx.query.disstid ?? ctx.query.id;
    if (!disstid) ctx.throw(400, "disstid 必填 (数字歌单 ID)");
    ctx.body = ok(await client.playlist.getTracks(disstid));
  });

  /** 专辑内歌曲列表 */
  router.get("/album/tracks", async (ctx) => {
    const albummid = String(ctx.query.albummid ?? "");
    if (!albummid) ctx.throw(400, "albummid 必填");
    ctx.body = ok(await client.playlist.getAlbumTracks(albummid));
  });

  /** 用户歌单: 创建的 (含私有) + 收藏的 (需登录态) */
  router.get("/user/songlists", async (ctx) => {
    const uin = String(ctx.query.uin ?? "").trim();
    if (!/^\d+$/.test(uin)) ctx.throw(400, "uin 必填 (数字 QQ 号)");
    const created = await client.playlist.getUserCreatedPlaylists(uin);
    const collected = await client.playlist.getUserCollectedPlaylists(uin);
    ctx.body = ok({
      hostname: created.hostname,
      created: created.lists,
      collected: collected.lists,
    });
  });

  /** 歌手信息与热门歌曲 */
  router.get("/singer", async (ctx) => {
    const singermid = String(ctx.query.singermid ?? "");
    if (!singermid) ctx.throw(400, "singermid 必填");
    ctx.body = ok(await client.execute(client.playlist.getSingerInfo(singermid)));
  });

  return router;
}

// ==================== 路由: /config ====================

/** defaultQuality 为公开可改项 (用户在 UI 中直接修改, 无需管理员) */
function configRouter(client, configStore) {
  const router = new Router();

  router.get("/config", async (ctx) => {
    ctx.set("Cache-Control", "no-store");
    const stats = await getAccountStats(client);
    const level = stats.level === "unknown" ? "none" : stats.level;
    ctx.body = ok({
      defaultQuality: configStore.toPublicJSON().defaultQuality,
      accountLevel: level,
      qualities: QUALITY_LIST.map((q) => ({
        ...q,
        minLevel: QUALITY_MIN_LEVEL[q.code] ?? "svip",
      })),
    });
  });

  router.put("/config", async (ctx) => {
    const body = ctx.request.body ?? {};
    if (body.defaultQuality !== undefined) {
      if (!parseSongFileType(String(body.defaultQuality))) {
        ctx.throw(400, `未知音质代码: ${body.defaultQuality}`);
      }
      await configStore.update({ defaultQuality: String(body.defaultQuality) });
    }
    ctx.body = ok(configStore.toPublicJSON());
  });

  return router;
}

// ==================== 应用装配 ====================

function createApp(options = {}) {
  const devicePath = options.devicePath;
  const credentialPath = options.credentialPath;
  const configPath = options.configPath;

  // 1. 创建凭证/配置存储, 优先于 Client 初始化(让 Client 直接持有 store 内的凭证)
  const store = new CredentialStore({ path: credentialPath });
  const configStore = new ConfigStore({ path: configPath });

  // 2. 创建 Client, 用 store 中的凭证进行初始化
  const client = new Client({
    platform: options.platform ?? Platform.ANDROID,
    devicePath,
    credential: store.credential.toJSON(),
  });

  const app = new Koa();
  app.use(errorHandler);
  app.use(bodyParser({ jsonLimit: "1mb" }));

  // 3. 健康检查 + 首页
  const root = new Router();
  root.get("/health", async (ctx) => {
    // 账号统计按等级汇总, 不暴露具体账号 (首页公开可访问)
    const stats = await getAccountStats(client);
    ctx.body = ok({
      status: "ok",
      time: new Date().toISOString(),
      loggedIn: store.credential.isLoggedIn(),
      accounts: stats.counts,
      accountLevel: stats.level,
    });
  });

  // 首页: 读取 src/public/index.html 并返回
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const PUBLIC_DIR = join(__dirname, "public");
  const INDEX_HTML_PATH = join(PUBLIC_DIR, "index.html");
  const LOGIN_HTML_PATH = join(PUBLIC_DIR, "login.html");
  let indexHtmlCache = null;
  let loginHtmlCache = null;
  root.get("/", (ctx) => {
    ctx.type = "text/html; charset=utf-8";
    ctx.set("Cache-Control", "no-store"); // 前端迭代频繁, 防止浏览器缓存旧页面
    if (!indexHtmlCache) {
      indexHtmlCache = existsSync(INDEX_HTML_PATH)
        ? readFileSync(INDEX_HTML_PATH, "utf-8")
        : "<h1>QQ Music API</h1><p>index.html not found at " + INDEX_HTML_PATH + "</p>";
    }
    ctx.body = indexHtmlCache;
  });
  root.get("/login", (ctx) => {
    ctx.type = "text/html; charset=utf-8";
    ctx.set("Cache-Control", "no-store");
    if (!loginHtmlCache) {
      loginHtmlCache = existsSync(LOGIN_HTML_PATH)
        ? readFileSync(LOGIN_HTML_PATH, "utf-8")
        : "<h1>QQ Music Login</h1><p>login.html not found at " + LOGIN_HTML_PATH + "</p>";
    }
    ctx.body = loginHtmlCache;
  });

  // 本地静态资源 (自托管的 APlayer 等, 避免浏览器端依赖国外 CDN)
  root.get("/vendor/:file", (ctx) => {
    const file = String(ctx.params.file ?? "");
    if (!/^[A-Za-z0-9._-]+$/.test(file)) ctx.throw(404);
    const p = join(PUBLIC_DIR, "vendor", file);
    if (!existsSync(p)) ctx.throw(404);
    ctx.type = file.endsWith(".js")
      ? "application/javascript; charset=utf-8"
      : file.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "application/octet-stream";
    ctx.set("Cache-Control", "public, max-age=86400");
    ctx.body = createReadStream(p);
  });
  app.use(root.routes());

  // 4. 业务路由
  app.use(searchRouter(client).routes());
  app.use(songRouter(client, configStore).routes());
  app.use(userRouter(client).routes());
  app.use(loginRouter(client, store).routes());
  app.use(mediaRouter(client).routes());
  app.use(configRouter(client, configStore).routes());

  return Object.assign(app, { client, store, configStore });
}

// ==================== 启动入口 ====================

const PORT = Number(process.env.PORT ?? 3300);
const DEVICE_PATH = process.env.DEVICE_PATH ?? "./device.json";
const CREDENTIAL_PATH = process.env.CREDENTIAL_PATH ?? "./credential.json";
const CONFIG_PATH = process.env.CONFIG_PATH ?? "./config.json";
const PLATFORM_STR = process.env.PLATFORM ?? "android";
const PLATFORM =
  PLATFORM_STR === "desktop" ? Platform.DESKTOP :
  PLATFORM_STR === "web" ? Platform.WEB :
  Platform.ANDROID;

const app = createApp({
  devicePath: DEVICE_PATH,
  credentialPath: CREDENTIAL_PATH,
  configPath: CONFIG_PATH,
  platform: PLATFORM,
});

app.listen(PORT, () => {
  console.log(`[qqmusic-api] listening on http://localhost:${PORT}`);
  console.log(`[qqmusic-api] device path     : ${DEVICE_PATH}`);
  console.log(`[qqmusic-api] credential path : ${CREDENTIAL_PATH}`);
  console.log(`[qqmusic-api] config path     : ${CONFIG_PATH}`);
  console.log(`[qqmusic-api] platform        : ${PLATFORM}`);
  console.log(`[qqmusic-api] admin key       : ${ADMIN_KEY ? "configured" : "NOT configured (管理接口不可用)"}`);
});
