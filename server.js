#!/usr/bin/env node
'use strict';

/* ==========================================================================
   简历智能填写 · 后端代理服务
   --------------------------------------------------------------------------
   职责：接收前端提交的自由文本 -> 调用 DeepSeek -> 规整为固定结构 -> 返回
   要点：DeepSeek 的 API Key 只保存在本机服务端（.env），
         前端可以把用户输入的密钥交给它，但自身不持久保存。
   依赖：无（仅使用 Node 内置模块，需要 Node 18+ 以获得全局 fetch）
   ========================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');

/* --------------------------- 本地环境变量 --------------------------- */
// 零依赖读取同目录下的 .env（该文件已写入 .gitignore，不会被提交到仓库）。
// 真实环境变量优先级更高，便于部署平台直接覆盖。
(function loadDotEnv() {
  try {
    const file = path.join(__dirname, '.env');
    if (!fs.existsSync(file)) return;
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line || line.charAt(0) === '#') return;
      line = line.replace(/^export\s+/i, '');   // 兼容 shell 风格的 export KEY=value
      const eq = line.indexOf('=');
      if (eq < 1) return;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      const q = val.charAt(0);
      if (val.length > 1 && (q === '"' || q === "'") && val.charAt(val.length - 1) === q) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    });
  } catch (e) {
    console.warn('读取 .env 失败（已忽略）: ' + e.message);
  }
})();

/* ------------------------------ 配置 ------------------------------ */

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const DEEPSEEK_ENDPOINT = process.env.DEEPSEEK_ENDPOINT || 'https://api.deepseek.com/chat/completions';

// 密钥只从环境变量或同目录 .env 读取，源码中不保留任何真实 Key。
// 本地开发：把 .env.example 复制成 .env，填入自己的 Key。
// 也可以用页面右上角的设置面板直接填入（会写回这个 .env 文件）。
// 部署平台：在平台的环境变量 / Secret 配置里设置 DEEPSEEK_API_KEY。
const API_KEY_FILE = path.join(__dirname, '.env');
let API_KEY = process.env.DEEPSEEK_API_KEY || '';

// 模型白名单。前两个别名适用于自建/中转网关；
// 若把 DEEPSEEK_ENDPOINT 指到官方 api.deepseek.com，请选 deepseek-v4-flash / deepseek-v4-pro
//（官方已于 2026-07-24 停用 deepseek-chat / deepseek-reasoner）
const MODELS = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'];
// 默认模型跟着上游走：官方 API 只认 deepseek-v4-*，网关则沿用短别名。
// 否则「不改任何环境变量直接 node server.js」会在上游撞「模型不存在」。
function isOfficialApi(endpoint) {
  return /(^|\/\/)api\.deepseek\.com(\/|$)/.test(String(endpoint || ''));
}
const OFFICIAL_API = isOfficialApi(DEEPSEEK_ENDPOINT);
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || (OFFICIAL_API ? 'deepseek-v4-flash' : 'deepseek-flash');

const MAX_TEXT_CHARS = Number(process.env.MAX_TEXT_CHARS || 8000);
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR || 30);
const RATE_WINDOW_MS = 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 90000);
const MAX_BODY_BYTES = 64 * 1024;

/* --------------------------- 提示词与结构 --------------------------- */

const SCHEMA_HINT = [
  '{',
  '  "personal": {',
  '    "name": "姓名", "phone": "手机号", "email": "邮箱",',
  '    "gender": "男/女", "age": "年龄数字", "nation": "民族",',
  '    "hometown": "籍贯，如 山东济南", "political": "政治面貌",',
  '    "gradYear": 2026',
  '  },',
  '  "intention": { "position": "求职岗位", "city": "期望城市" },',
  '  "edu": [',
  '    { "title": "学校名", "sub": "专业 · 学历", "date": "2022.09 - 2026.06",',
  '      "notes": ["GPA 3.7", "专业排名前 10%", "主修课程：…"] }',
  '  ],',
  '  "work": [',
  '    { "title": "公司名", "sub": "职位", "date": "2025.07 - 2025.09",',
  '      "notes": ["用一句话描述职责或成果，带量化数据"] }',
  '  ],',
  '  "project": [',
  '    { "title": "项目名", "sub": "角色 · 技术栈", "date": "起止时间或空串",',
  '      "notes": ["项目成果，带量化数据"] }',
  '  ],',
  '  "skills": ["技能短语，不带主语、不用第一人称（如「熟练使用 SQL，掌握复杂查询、窗口函数与性能调优」）"],',
  '  "awards": ["每条荣誉/奖项/证书一项"],',
  '  "unmatched": ["确实无法归入以上任何板块的原文行"]',
  '}'
].join('\n');

const SYSTEM_PROMPT = [
  '你是一个中文简历信息抽取引擎。用户会用自然、口语、可能杂乱的语言描述自己的经历，',
  '你需要准确理解语义并抽取为结构化 JSON。',
  '',
  '硬性要求：',
  '1. 只输出 JSON，不要任何解释文字、不要 markdown 代码块标记。',
  '2. 严格遵循下面的 JSON 结构（字段名与层级不可改动）：',
  SCHEMA_HINT,
  '',
  '3. 语义判断规则（非常重要）：',
  '   - 姓名、籍贯（如「山东济南人」→ hometown 填「山东济南」）、性别、年龄、民族、政治面貌、联系方式，一律进 personal；',
  '     绝不能因为句子里出现「优秀」「先进」等词就把个人信息当成奖项。',
  '   - 学校、专业、学历、起止时间、GPA、排名、主修课程 → edu。',
  '   - 公司/单位、职位 → work；实习经历也放 work，职位写成「XX实习生」。',
  '   - 课题/系统/平台/竞赛作品 → project，并在 sub 里写角色与技术栈。',
  '   - 技能描述（熟悉/掌握/了解 XX）→ skills。',
  '   - 荣誉、奖学金、竞赛获奖、证书（CET-6、普通话等）→ awards，一项一条。',
  '   - 时间统一格式化为「YYYY.MM - YYYY.MM」，仍在进行中写「YYYY.MM - 至今」。',
  '4. 没有提到的字段请省略或留空字符串/空数组，不要臆造内容。',
  '5. 描述性文字要保留用户的量化成果（如「提升 35%」「日活 2000+」），不要改写成空话套话；',
  '   但口语化的措辞必须转成简历书面语，规则见第 7 条。',
  '6. 如果某一行确实无法归入任何板块，放入 unmatched 并保留原文。',
  '7. 人称与文体（最容易被忽略的一条，务必执行）：',
  '   简历正文是第三人称书面语。除 personal.name 之外，所有输出字段的文字里',
  '   都不能出现「我」「我们」「咱」「本人」「自己」「我的」「我叫」等第一人称代词。',
  '   改写时守住三条底线：不改变事实、不新增原文没有的信息、不丢掉量化数据；',
  '   熟练程度要保留（「我用得很熟」→「熟练使用」，「基本会一点」→「了解」）。',
  '   示例：',
  '     「SQL 我用得很熟，复杂查询、窗口函数、性能调优都没问题」',
  '       → skills: 「熟练使用 SQL，掌握复杂查询、窗口函数与性能调优」',
  '     「我在携程做数据分析，主要围绕酒店业务」',
  '       → work.title「携程」、work.sub「数据分析师」、notes「负责酒店业务的数据分析」',
  '     「把新客 7 日首单转化率从 21% 提到 27%」',
  '       → notes「新客 7 日首单转化率从 21% 提升至 27%」（数字一字不改，只去掉口语）',
  '   唯一的例外是 unmatched：无法归类时按第 6 条保留原文，不做改写。'
].join('\n');

/* ------------------------- 结构规整（适配层） ------------------------- */

function str(v) { return (v == null) ? '' : String(v).trim(); }
function arr(v) { return Array.isArray(v) ? v : []; }

const MONTHS = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12 };

function normYm(s) {
  s = String(s || '').trim();
  if (!s) return '';
  if (/至今|现在|如今|目前|present|now/i.test(s)) return '至今';
  const m = s.match(/((?:19|20)\d{2})\s*[年\.\-\/]?\s*(\d{1,2}|十[一二]?|[一二三四五六七八九])\s*月?/);
  if (!m) {
    const y = s.match(/((?:19|20)\d{2})/);
    return y ? y[1] : '';
  }
  const yy = m[1];
  const raw = m[2];
  const mm = MONTHS[raw] || parseInt(raw, 10);
  if (!mm || mm < 1 || mm > 12) return yy;
  return yy + '.' + ('0' + mm).slice(-2);
}

function normDate(date) {
  let s = String(date || '').trim();
  if (!s) return '';

  // 进行中写法：xxx至今 / xxx - 至今 / xxx至现在。
  // 必须在下面替换「至」之前拦截，否则「至今」的「至」会被误当成连接符。
  const nowMatch = s.match(/^(.+?)\s*[~～—–－-]?\s*(?:至|到)?\s*(?:今|现在|目前|present|now)\s*$/i);
  if (nowMatch) {
    const head = normYm(nowMatch[1]);
    if (head) return head + ' - 至今';
  }

  s = s.replace(/\s*[~～—–－]\s*/g, ' - ')
       .replace(/\s*至(?!今)\s*/g, ' - ')
       .replace(/\s+/g, ' ')
       .trim();
  // 「2025.07-至今」这类写法会因连接符叠加产生重复分隔符，先折叠掉
  s = s.replace(/(?:\s*-\s*){2,}/g, ' - ');
  const parts = s.split(/\s*-\s*/).filter(Boolean);
  if (parts.length >= 2) {
    const a = normYm(parts[0]);
    const b = normYm(parts[1]);
    if (a && b) return a + ' - ' + b;
    if (a) return a;
    return s;
  }
  return normYm(s) || s;
}

function strArr(v) {
  if (typeof v === 'string') v = v.trim() ? [v] : [];
  else if (v && !Array.isArray(v) && typeof v === 'object') v = [v];
  return arr(v).map(function (x) {
    if (x == null) return '';
    if (typeof x === 'string') return x.trim();
    return str(x.text || x.name || x.value || x.title || '');
  }).filter(Boolean);
}

function objArr(v) {
  if (v && !Array.isArray(v) && typeof v === 'object') v = [v];
  else if (typeof v === 'string') v = v.trim() ? [v] : [];
  return arr(v).map(function (x) {
    if (x == null) return null;
    if (typeof x === 'string') {
      const s = x.trim();
      return s ? { title: s, sub: '', date: '', notes: [] } : null;
    }
    if (typeof x !== 'object') return null;
    const title = str(x.title || x.name || x.company || x.school || x.project || '');
    const sub = str(x.sub || x.position || x.role || x.major || x.degree || '');
    const date = normDate(str(x.date || x.period || x.time || x.duration || ''));
    const notes = strArr(x.notes || x.details || x.descriptions || x.highlights || []);
    if (!title && !sub && !notes.length) return null;
    return { title: title || sub, sub: (title && sub && sub !== title) ? sub : '', date: date, notes: notes };
  }).filter(Boolean);
}

function normalize(raw) {
  const d = (raw && typeof raw === 'object') ? raw : {};
  const p = d.personal && typeof d.personal === 'object' ? d.personal : {};
  const it = d.intention && typeof d.intention === 'object' ? d.intention : {};
  const gradYear = parseInt(p.gradYear, 10);

  return {
    personal: {
      name: str(p.name),
      phone: str(p.phone),
      email: str(p.email),
      gender: str(p.gender),
      age: str(p.age),
      nation: str(p.nation),
      hometown: str(p.hometown),
      political: str(p.political),
      gradYear: isNaN(gradYear) ? null : gradYear
    },
    intention: { position: str(it.position), city: str(it.city) },
    edu: objArr(d.edu || d.education),
    work: objArr(d.work || d.experience || d.internship),
    project: objArr(d.project || d.projects),
    skills: strArr(d.skills),
    awards: strArr(d.awards || d.honors),
    unmatched: strArr(d.unmatched)
  };
}

function extractJSON(content) {
  let s = String(content || '').trim();
  if (!s) return null;
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch (e) { /* fallthrough */ }
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i > -1 && j > i) {
    try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { /* give up */ }
  }
  return null;
}

/* ------------------------------ 限流 ------------------------------ */

const hits = new Map();

function rateLimit(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > RATE_WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return { ok: true, remaining: RATE_LIMIT - 1 };
  }
  if (rec.count >= RATE_LIMIT) {
    return { ok: false, remaining: 0, resetInMin: Math.max(1, Math.ceil((rec.start + RATE_WINDOW_MS - now) / 60000)) };
  }
  rec.count++;
  return { ok: true, remaining: RATE_LIMIT - rec.count };
}

setInterval(function () {
  const now = Date.now();
  for (const entry of hits) {
    if (now - entry[1].start > RATE_WINDOW_MS) hits.delete(entry[0]);
  }
}, 10 * 60 * 1000).unref();

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  const real = req.headers['x-real-ip'];
  if (real) return String(real).trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* ------------------------------ 工具 ------------------------------ */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', function (c) {
      // 已判定超限：丢弃后续数据即可，不能 destroy —— 那会在回包前掐断连接，
      // 客户端只会看到连接被重置，拿不到 413 的说明。
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        const err = new Error('body too large');
        err.tooLarge = true;
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function isRealKey(key) {
  const s = String(key || '').trim();
  if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(s)) return false;
  // 排除 .env.example 里的占位符。否则「照抄模板忘了改」会显示「密钥已就绪」，
  // 直到真正调用才报 401，排查成本很高。
  return !/your[-_]?key|placeholder|change[-_]?me|xxxx/i.test(s);
}
function keyLooksValid() { return isRealKey(API_KEY); }
function keyIsPlaceholder() { return !!API_KEY && !keyLooksValid(); }

/* 把密钥写回同目录的 .env：保留其它配置行，只替换 DEEPSEEK_API_KEY。
   页面上的「保存密钥」走这里，用户就不必手动编辑文件了。 */
function saveApiKey(key) {
  let content = '';
  try { content = fs.readFileSync(API_KEY_FILE, 'utf8'); } catch (e) { content = ''; }
  const out = [];
  let replaced = false;
  content.split(/\r?\n/).forEach(function (line) {
    if (/^\s*#?\s*DEEPSEEK_API_KEY\s*=/.test(line)) {
      if (!replaced) { out.push('DEEPSEEK_API_KEY=' + key); replaced = true; }
      return;   // 同名的重复行 / 被注释掉的旧值都丢掉
    }
    out.push(line);
  });
  if (!replaced) out.push('DEEPSEEK_API_KEY=' + key);
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  fs.writeFileSync(API_KEY_FILE, text, 'utf8');
}

/* --------------------------- 调用 DeepSeek --------------------------- */

async function callDeepSeek(text, model) {
  const body = {
    model: model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: '请把下面的信息抽取为 JSON：\n\n' + text }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2,
    max_tokens: 8000
  };

  let resp;
  try {
    resp = await fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_KEY
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new HttpError(504, '模型响应超时，请稍后重试。');
    }
    throw new HttpError(502, '无法连接模型服务，请稍后重试。');
  }

  const txt = await resp.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (e) { /* keep null */ }

  if (!resp.ok) {
    let msg = (data && data.error && data.error.message) || ('HTTP ' + resp.status);
    if (resp.status === 401) msg = '服务端 API Key 无效或已失效，请联系管理员。';
    else if (resp.status === 402) msg = '服务端账户余额不足，请联系管理员充值。';
    else if (resp.status === 429) msg = '模型服务繁忙，请稍后重试。';
    else if (resp.status >= 500) msg = '模型服务暂时不可用，请稍后重试。';
    throw new HttpError(502, msg);
  }

  const content = data && data.choices && data.choices[0] &&
    data.choices[0].message && data.choices[0].message.content;
  const parsed = extractJSON(content);
  if (!parsed) throw new HttpError(502, '模型返回内容无法解析，请重试一次。');

  return { data: normalize(parsed), usage: (data && data.usage) || null };
}

/* ------------------------------ 路由 ------------------------------ */

async function handle(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const path = (new URL(req.url, 'http://localhost').pathname || '/').replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && (path === '/' || path === '/health')) {
    sendJSON(res, 200, {
      ok: true,
      service: 'resume-ai-proxy',
      keyConfigured: keyLooksValid(),
      models: MODELS
    });
    return;
  }

  // 页面上保存 API Key：只允许本机访问。
  // 注意不能看 X-Forwarded-For（可伪造），必须用 TCP 连接的 remoteAddress。
  if (path === '/api/config') {
    if (req.method !== 'POST') { sendJSON(res, 405, { error: '仅支持 POST 请求' }); return; }
    const remote = String((req.socket && req.socket.remoteAddress) || '');
    const isLocal = /^127\./.test(remote) || remote === '::1' || /^::ffff:127\./.test(remote);
    if (!isLocal) {
      sendJSON(res, 403, { error: '密钥只能在本机（127.0.0.1）配置。远程部署请改用环境变量 DEEPSEEK_API_KEY。' });
      return;
    }
    let cfg;
    try {
      const raw = await readBody(req);
      cfg = raw ? JSON.parse(raw) : {};
    } catch (e) {
      sendJSON(res, 400, { error: '请求格式错误，需要 JSON 请求体。' });
      return;
    }
    const key = String(cfg.apiKey || '').trim();
    if (!isRealKey(key)) {
      sendJSON(res, 400, { error: '密钥格式不正确：应以 sk- 开头，且不能是示例占位符。' });
      return;
    }
    try {
      saveApiKey(key);
    } catch (e) {
      sendJSON(res, 500, { error: '写入 .env 失败：' + e.message });
      return;
    }
    API_KEY = key;   // 立即生效，无需重启服务
    console.log('[config] 已通过页面配置 API Key，并写入 .env');
    sendJSON(res, 200, { ok: true, keyConfigured: true });
    return;
  }

  if (path !== '/api/parse') { sendJSON(res, 404, { error: '接口不存在' }); return; }
  if (req.method !== 'POST') { sendJSON(res, 405, { error: '仅支持 POST 请求' }); return; }

  if (!keyLooksValid()) {
    sendJSON(res, 500, {
      error: keyIsPlaceholder()
        ? '服务端密钥仍是占位符，请把 .env 里的 DEEPSEEK_API_KEY 换成真实密钥。'
        : '服务端尚未配置模型密钥，请先在 .env 中设置 DEEPSEEK_API_KEY。'
    });
    return;
  }

  const ip = clientIp(req);
  const rl = rateLimit(ip);
  if (!rl.ok) {
    sendJSON(res, 429, { error: '当前请求过于频繁，请在约 ' + rl.resetInMin + ' 分钟后重试。' });
    return;
  }

  let payload;
  try {
    const raw = await readBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch (e) {
    if (e && e.tooLarge) {
      sendJSON(res, 413, { error: '请求体过大（上限 ' + Math.round(MAX_BODY_BYTES / 1024) + ' KB）。' });
      return;
    }
    sendJSON(res, 400, { error: '请求格式错误，需要 JSON 请求体。' });
    return;
  }

  const text = String(payload.text || '').trim();
  if (!text) { sendJSON(res, 400, { error: '请提供需要解析的文本。' }); return; }
  if (text.length > MAX_TEXT_CHARS) {
    sendJSON(res, 400, { error: '文本过长（上限 ' + MAX_TEXT_CHARS + ' 字），请精简后重试。' });
    return;
  }

  let model = String(payload.model || DEFAULT_MODEL);
  if (MODELS.indexOf(model) === -1) model = DEFAULT_MODEL;

  const startedAt = Date.now();
  try {
    const out = await callDeepSeek(text, model);
    const tokens = (out.usage && out.usage.total_tokens) || 0;
    console.log('[parse] ok   ip=' + ip + ' model=' + model + ' chars=' + text.length +
      ' tokens=' + tokens + ' ms=' + (Date.now() - startedAt) + ' remaining=' + rl.remaining);
    sendJSON(res, 200, { ok: true, data: out.data, usage: out.usage, remaining: rl.remaining });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = (err && err.message) ? err.message : '服务异常，请稍后重试。';
    console.error('[parse] fail ip=' + ip + ' model=' + model + ' status=' + status +
      ' ms=' + (Date.now() - startedAt) + ' ' + message);
    sendJSON(res, status, { error: message });
  }
}

/* ------------------------------ 启动 ------------------------------ */

if (require.main === module) {
  const server = http.createServer(function (req, res) {
    handle(req, res).catch(function (err) {
      console.error('[fatal]', err);
      try { sendJSON(res, 500, { error: '服务内部错误' }); } catch (e) { /* ignore */ }
    });
  });

  // 端口被占用时 Node 会抛未捕获的 'error' 事件，直接把整个进程打崩，
  // 用户看到的是一屏英文堆栈。这里换成能照着做的中文提示。
  server.on('error', function (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error('');
      console.error('启动失败：端口 ' + PORT + ' 已被占用。');
      console.error('通常是上一次启动的窗口还开着 —— 先关掉那个窗口，或换一个端口再启动：');
      console.error('  Windows :  set PORT=3001 && node server.js');
      console.error('  macOS/Linux :  PORT=3001 node server.js');
      console.error('');
      process.exit(1);
    }
    if (err && err.code === 'EACCES') {
      console.error('启动失败：没有权限监听端口 ' + PORT + '（1024 以下的端口通常需要管理员权限）。');
      process.exit(1);
    }
    console.error('启动失败：', err);
    process.exit(1);
  });

  server.listen(PORT, HOST, function () {
    console.log('resume-ai-proxy listening on http://' + HOST + ':' + PORT);
    // 把生效配置打出来：默认模型是随上游自适应的，不显示清楚很容易「模型不存在」却找不到原因
    console.log('上游: ' + DEEPSEEK_ENDPOINT + (OFFICIAL_API ? '（官方 API）' : '（自建/中转网关）'));
    console.log('默认模型: ' + DEFAULT_MODEL + '  可选: ' + MODELS.join(' / '));
    if (!API_KEY) {
      console.warn('WARNING: 尚未配置 DEEPSEEK_API_KEY，/api/parse 将返回 500。');
      console.warn('  最简单的方式：打开简历页面 → 点「✨ 智能填写」，在设置里粘贴密钥（会写回 .env）。');
      console.warn('  也可以手动：复制 .env.example 为 .env 填入 Key，或用环境变量 DEEPSEEK_API_KEY=sk-xxx。');
    } else if (keyIsPlaceholder()) {
      console.warn('WARNING: DEEPSEEK_API_KEY 看起来是占位符（' + API_KEY.slice(0, 12) + '…），不是真实密钥。');
      console.warn('  请打开 .env，把 DEEPSEEK_API_KEY 换成在 https://platform.deepseek.com 申请的真实 Key。');
    } else {
      console.log('DEEPSEEK_API_KEY 已就绪，限流 ' + RATE_LIMIT + ' 次/小时/IP');
    }
  });
}

module.exports = {
  normalize: normalize,
  extractJSON: extractJSON,
  normDate: normDate,
  normYm: normYm,
  strArr: strArr,
  objArr: objArr,
  handle: handle,
  SYSTEM_PROMPT: SYSTEM_PROMPT,
  MODELS: MODELS,
  DEFAULT_MODEL: DEFAULT_MODEL,
  isOfficialApi: isOfficialApi
};

