const axios = require('axios');

const TMDB_BASE_URL = 'https://api.themoviedb.org';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org';
const CACHE_DURATION = 10 * 60 * 1000;
const MAX_CACHE_SIZE = 1000;
const MAX_CALL_LOGS = 500;
const STATS_TIME_ZONE = process.env.STATS_TIME_ZONE || 'Asia/Shanghai';
const STATS_KEY_PREFIX = process.env.STATS_KEY_PREFIX || 'tmdb-proxy:stats';
const STATS_TTL_SECONDS = 3 * 24 * 60 * 60;
const KV_REST_API_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const cache = new Map();
const dailyStats = new Map();

function getTodayKey() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: STATS_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
}

function getOrCreateTodayStats() {
    const today = getTodayKey();

    for (const key of dailyStats.keys()) {
        if (key !== today) {
            dailyStats.delete(key);
        }
    }

    if (!dailyStats.has(today)) {
        dailyStats.set(today, {
            date: today,
            timeZone: STATS_TIME_ZONE,
            total: 0,
            byPath: new Map(),
            calls: []
        });
    }

    return dailyStats.get(today);
}

function recordMemoryApiCall(entry) {
    const stats = getOrCreateTodayStats();
    const pathStats = stats.byPath.get(entry.path) || {
        path: entry.path,
        count: 0,
        lastStatus: null,
        lastCalledAt: null
    };

    stats.total += 1;
    pathStats.count += 1;
    pathStats.lastStatus = entry.status;
    pathStats.lastCalledAt = entry.calledAt;
    stats.byPath.set(entry.path, pathStats);

    stats.calls.unshift(entry);
    if (stats.calls.length > MAX_CALL_LOGS) {
        stats.calls.length = MAX_CALL_LOGS;
    }
}

function hasKvStats() {
    return Boolean(KV_REST_API_URL && KV_REST_API_TOKEN);
}

function getStatsKeys(date) {
    const prefix = `${STATS_KEY_PREFIX}:${date}`;

    return {
        total: `${prefix}:total`,
        pathCounts: `${prefix}:pathCounts`,
        pathLastStatus: `${prefix}:pathLastStatus`,
        pathLastCalledAt: `${prefix}:pathLastCalledAt`,
        calls: `${prefix}:calls`
    };
}

async function kvPipeline(commands) {
    const response = await axios.post(
        `${KV_REST_API_URL.replace(/\/$/, '')}/pipeline`,
        commands,
        {
            headers: {
                Authorization: `Bearer ${KV_REST_API_TOKEN}`,
                'Content-Type': 'application/json'
            }
        }
    );

    for (const item of response.data) {
        if (item.error) {
            throw new Error(item.error);
        }
    }

    return response.data.map((item) => item.result);
}

function hashToObject(value) {
    if (!value) {
        return {};
    }

    if (!Array.isArray(value)) {
        return value;
    }

    const result = {};
    for (let index = 0; index < value.length; index += 2) {
        result[value[index]] = value[index + 1];
    }

    return result;
}

async function recordKvApiCall(entry) {
    const keys = getStatsKeys(getTodayKey());
    const call = JSON.stringify(entry);
    const keysToExpire = Object.values(keys);

    await kvPipeline([
        ['INCR', keys.total],
        ['HINCRBY', keys.pathCounts, entry.path, 1],
        ['HSET', keys.pathLastStatus, entry.path, String(entry.status)],
        ['HSET', keys.pathLastCalledAt, entry.path, entry.calledAt],
        ['LPUSH', keys.calls, call],
        ['LTRIM', keys.calls, 0, MAX_CALL_LOGS - 1],
        ...keysToExpire.map((key) => ['EXPIRE', key, STATS_TTL_SECONDS])
    ]);
}

async function recordApiCall(entry) {
    if (!hasKvStats()) {
        recordMemoryApiCall(entry);
        return;
    }

    try {
        await recordKvApiCall(entry);
    } catch (error) {
        console.error('KV stats write failed:', error);
        recordMemoryApiCall(entry);
    }
}

function clearMemoryStats() {
    dailyStats.delete(getTodayKey());
}

async function clearKvStats() {
    await kvPipeline([
        ['DEL', ...Object.values(getStatsKeys(getTodayKey()))]
    ]);
}

async function clearStats() {
    clearMemoryStats();

    if (hasKvStats()) {
        await clearKvStats();
        return 'kv';
    }

    return 'memory';
}

function emptyStatsPayload(storageMode) {
    return {
        date: getTodayKey(),
        timeZone: STATS_TIME_ZONE,
        storageMode,
        total: 0,
        retainedLogs: 0,
        maxLogs: MAX_CALL_LOGS,
        byPath: [],
        calls: []
    };
}

async function getKvStatsPayload() {
    const date = getTodayKey();
    const keys = getStatsKeys(date);
    const [total, pathCountsResult, lastStatusResult, lastCalledAtResult, callsResult] = await kvPipeline([
        ['GET', keys.total],
        ['HGETALL', keys.pathCounts],
        ['HGETALL', keys.pathLastStatus],
        ['HGETALL', keys.pathLastCalledAt],
        ['LRANGE', keys.calls, 0, MAX_CALL_LOGS - 1]
    ]);
    const pathCounts = hashToObject(pathCountsResult);
    const lastStatus = hashToObject(lastStatusResult);
    const lastCalledAt = hashToObject(lastCalledAtResult);
    const calls = (callsResult || []).map((item) => JSON.parse(item));

    return {
        date,
        timeZone: STATS_TIME_ZONE,
        storageMode: 'kv',
        total: Number(total || 0),
        retainedLogs: calls.length,
        maxLogs: MAX_CALL_LOGS,
        byPath: Object.entries(pathCounts)
            .map(([path, count]) => ({
                path,
                count: Number(count || 0),
                lastStatus: lastStatus[path] || null,
                lastCalledAt: lastCalledAt[path] || null
            }))
            .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)),
        calls
    };
}

async function getStatsPayload() {
    if (hasKvStats()) {
        try {
            return await getKvStatsPayload();
        } catch (error) {
            console.error('KV stats read failed:', error);
        }
    }

    const stats = getOrCreateTodayStats();

    return {
        date: stats.date,
        timeZone: stats.timeZone,
        storageMode: 'memory',
        total: stats.total,
        retainedLogs: stats.calls.length,
        maxLogs: MAX_CALL_LOGS,
        byPath: Array.from(stats.byPath.values())
            .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)),
        calls: stats.calls
    };
}

function isAdminRoute(pathname) {
    return pathname === '/admin' || pathname === '/admin/data' || pathname === '/admin/clear';
}

function isIgnoredRoute(pathname) {
    return pathname === '/favicon.ico';
}

function isImageRoute(pathname) {
    return pathname.startsWith('/t/p/');
}

function timingSafeEqualString(left, right) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);

    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return require('crypto').timingSafeEqual(leftBuffer, rightBuffer);
}

function isAdminAuthorized(req) {
    if (!ADMIN_PASSWORD) {
        return true;
    }

    const authHeader = req.headers.authorization || '';
    const [scheme, credentials] = authHeader.split(' ');

    if (scheme !== 'Basic' || !credentials) {
        return false;
    }

    const decoded = Buffer.from(credentials, 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');

    if (separatorIndex === -1) {
        return false;
    }

    const username = decoded.slice(0, separatorIndex);
    const password = decoded.slice(separatorIndex + 1);

    return timingSafeEqualString(username, ADMIN_USER) &&
        timingSafeEqualString(password, ADMIN_PASSWORD);
}

function requestAdminAuth(res) {
    res.setHeader('WWW-Authenticate', 'Basic realm="TMDB Proxy Admin", charset="UTF-8"');
    res.status(401).json({
        error: 'Unauthorized'
    });
}

function cleanExpiredCache() {
    const now = Date.now();
    for (const [key, value] of cache.entries()) {
        if (now > value.expiry) {
            cache.delete(key);
        }
    }
}

function checkCacheSize() {
    if (cache.size > MAX_CACHE_SIZE) {
        const entries = Array.from(cache.entries());
        entries.sort((a, b) => a[1].expiry - b[1].expiry);

        const deleteCount = cache.size - MAX_CACHE_SIZE;
        entries.slice(0, deleteCount).forEach(([key]) => cache.delete(key));

        console.log(`Cleaned ${deleteCount} old cache entries`);
    }
}

function sendAdminPage(res) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TMDB Proxy Admin</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f7f8fa;
      color: #17202a;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 24px clamp(16px, 4vw, 48px);
      border-bottom: 1px solid #e4e8ee;
      background: #ffffff;
    }
    h1 { margin: 0; font-size: clamp(22px, 3vw, 32px); font-weight: 700; }
    main { padding: 24px clamp(16px, 4vw, 48px) 48px; }
    .meta { color: #657385; margin-top: 6px; font-size: 14px; }
    .toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    button {
      min-height: 36px;
      border: 1px solid #c9d2de;
      border-radius: 6px;
      background: #ffffff;
      color: #17202a;
      padding: 0 14px;
      cursor: pointer;
      font-weight: 600;
    }
    button:hover { background: #f1f4f8; }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 22px;
    }
    .metric {
      border: 1px solid #e1e6ed;
      border-radius: 8px;
      background: #ffffff;
      padding: 16px;
    }
    .metric span { display: block; color: #657385; font-size: 13px; }
    .metric strong { display: block; margin-top: 8px; font-size: 28px; }
    section { margin-top: 22px; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    .table-wrap {
      overflow-x: auto;
      border: 1px solid #e1e6ed;
      border-radius: 8px;
      background: #ffffff;
    }
    table { width: 100%; border-collapse: collapse; min-width: 760px; }
    th, td { padding: 11px 12px; border-bottom: 1px solid #edf0f4; text-align: left; vertical-align: top; }
    th { color: #4a5868; font-size: 13px; background: #fafbfc; }
    td { font-size: 14px; }
    tr:last-child td { border-bottom: 0; }
    code {
      overflow-wrap: anywhere;
      word-break: break-word;
      font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 13px;
      color: #243447;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border-radius: 999px;
      padding: 0 8px;
      font-size: 12px;
      font-weight: 700;
      background: #edf6ee;
      color: #1d6b33;
    }
    .badge.miss { background: #fff3dc; color: #8a5700; }
    .empty { padding: 24px; color: #657385; }
    @media (max-width: 640px) {
      header { align-items: flex-start; flex-direction: column; }
      table { min-width: 680px; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>TMDB Proxy Admin</h1>
      <div class="meta" id="meta">加载中...</div>
    </div>
    <div class="toolbar">
      <button type="button" id="refresh">刷新</button>
      <button type="button" id="clear">清空</button>
    </div>
  </header>
  <main>
    <div class="summary">
      <div class="metric"><span>今日调用次数</span><strong id="total">0</strong></div>
      <div class="metric"><span>不同 API 路径</span><strong id="paths">0</strong></div>
      <div class="metric"><span>保留调用内容</span><strong id="logs">0</strong></div>
    </div>

    <section>
      <h2>API 路径统计</h2>
      <div class="table-wrap" id="pathTable"></div>
    </section>

    <section>
      <h2>调用内容</h2>
      <div class="table-wrap" id="callTable"></div>
    </section>
  </main>

  <script>
    const text = (value) => String(value ?? '');
    const escapeHtml = (value) => text(value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]));
    const readablePath = (value) => {
      try {
        return decodeURIComponent(text(value));
      } catch {
        return text(value);
      }
    };

    function renderTable(container, headers, rows, emptyText) {
      if (!rows.length) {
        container.innerHTML = '<div class="empty">' + escapeHtml(emptyText) + '</div>';
        return;
      }

      container.innerHTML =
        '<table><thead><tr>' +
        headers.map((header) => '<th>' + escapeHtml(header) + '</th>').join('') +
        '</tr></thead><tbody>' +
        rows.join('') +
        '</tbody></table>';
    }

    function renderStats(data) {
      document.getElementById('meta').textContent =
        '日期 ' + data.date + ' · 时区 ' + data.timeZone + ' · 最多保留最近 ' + data.maxLogs + ' 条调用内容';
      document.getElementById('total').textContent = data.total;
      document.getElementById('paths').textContent = data.byPath.length;
      document.getElementById('logs').textContent = data.retainedLogs;

      renderTable(
        document.getElementById('pathTable'),
        ['路径', '次数', '最后状态', '最后调用时间'],
        data.byPath.map((item) =>
          '<tr><td><code title="' + escapeHtml(item.path) + '">' + escapeHtml(readablePath(item.path)) + '</code></td><td>' + item.count +
          '</td><td>' + escapeHtml(item.lastStatus) + '</td><td>' + escapeHtml(item.lastCalledAt) + '</td></tr>'
        ),
        '今天还没有 API 调用。'
      );

      renderTable(
        document.getElementById('callTable'),
        ['时间', '方法', '路径', '状态', '缓存', '耗时'],
        data.calls.map((item) =>
          '<tr><td>' + escapeHtml(item.calledAt) + '</td><td>' + escapeHtml(item.method) +
          '</td><td><code title="' + escapeHtml(item.path) + '">' + escapeHtml(readablePath(item.path)) + '</code></td><td>' + escapeHtml(item.status) +
          '</td><td><span class="badge ' + (item.cacheHit ? '' : 'miss') + '">' +
          (item.cacheHit ? 'HIT' : 'MISS') + '</span></td><td>' + escapeHtml(item.durationMs) + ' ms</td></tr>'
        ),
        '今天还没有调用内容。'
      );
    }

    function emptyStats() {
      return {
        date: new Intl.DateTimeFormat('en-CA', {
          timeZone: '${STATS_TIME_ZONE}',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        }).format(new Date()),
        timeZone: '${STATS_TIME_ZONE}',
        storageMode: '',
        total: 0,
        retainedLogs: 0,
        maxLogs: ${MAX_CALL_LOGS},
        byPath: [],
        calls: []
      };
    }

    async function loadStats() {
      const response = await fetch('/admin/data?_=' + Date.now(), {
        cache: 'no-store',
        credentials: 'same-origin'
      });
      renderStats(await response.json());
    }

    document.getElementById('refresh').addEventListener('click', loadStats);
    document.getElementById('clear').addEventListener('click', async () => {
      if (!confirm('清空今天的统计？')) return;
      const clearButton = document.getElementById('clear');
      clearButton.disabled = true;
      renderStats(emptyStats());
      try {
        const response = await fetch('/admin/clear?_=' + Date.now(), {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin'
        });
        if (!response.ok) throw new Error('清空失败：HTTP ' + response.status);
        renderStats(await response.json());
      } catch (error) {
        document.getElementById('meta').textContent = error.message;
      } finally {
        clearButton.disabled = false;
      }
    });
    loadStats().catch((error) => {
      document.getElementById('meta').textContent = '加载失败：' + error.message;
    });
  </script>
</body>
</html>`);
}

setInterval(cleanExpiredCache, CACHE_DURATION);

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const fullPath = req.url;
    const pathname = fullPath.split('?')[0];

    if (isAdminRoute(pathname)) {
        if (!isAdminAuthorized(req)) {
            requestAdminAuth(res);
            return;
        }

        if (req.method === 'GET' && pathname === '/admin') {
            sendAdminPage(res);
            return;
        }

        if (req.method === 'GET' && pathname === '/admin/data') {
            res.setHeader('Cache-Control', 'no-store');
            res.status(200).json(await getStatsPayload());
            return;
        }

        if (req.method === 'POST' && pathname === '/admin/clear') {
            res.setHeader('Cache-Control', 'no-store');
            res.status(200).json(emptyStatsPayload(await clearStats()));
            return;
        }

        res.status(405).json({
            error: 'Method not allowed'
        });
        return;
    }

    if (isIgnoredRoute(pathname)) {
        res.status(204).end();
        return;
    }

    const startedAt = Date.now();
    let statusCode = 500;
    let cacheHit = false;

    try {
        const authHeader = req.headers.authorization;
        const cacheKey = fullPath;
        const imageRequest = isImageRoute(pathname);

        if (cache.has(cacheKey)) {
            const cachedData = cache.get(cacheKey);
            if (Date.now() < cachedData.expiry) {
                statusCode = 200;
                cacheHit = true;
                console.log('Cache hit:', fullPath);
                await recordApiCall({
                    calledAt: new Date().toISOString(),
                    method: req.method,
                    path: fullPath,
                    status: statusCode,
                    cacheHit,
                    durationMs: Date.now() - startedAt
                });
                if (imageRequest) {
                    if (cachedData.contentType) {
                        res.setHeader('Content-Type', cachedData.contentType);
                    }
                    return res.status(200).send(Buffer.from(cachedData.data));
                }

                return res.status(200).json(cachedData.data);
            }

            cache.delete(cacheKey);
        }

        const tmdbUrl = `${imageRequest ? TMDB_IMAGE_BASE_URL : TMDB_BASE_URL}${fullPath}`;
        const config = imageRequest ? { responseType: 'arraybuffer' } : {};

        if (authHeader) {
            config.headers = {
                Authorization: authHeader
            };
        }

        const response = await axios.get(tmdbUrl, config);
        statusCode = response.status;

        if (response.status === 200) {
            checkCacheSize();

            cache.set(cacheKey, {
                data: response.data,
                contentType: response.headers['content-type'],
                expiry: Date.now() + CACHE_DURATION
            });
            console.log('Cache miss and stored:', fullPath);
        } else {
            console.log('Response not cached due to non-200 status:', response.status);
        }

        await recordApiCall({
            calledAt: new Date().toISOString(),
            method: req.method,
            path: fullPath,
            status: statusCode,
            cacheHit,
            durationMs: Date.now() - startedAt
        });

        if (imageRequest) {
            if (response.headers['content-type']) {
                res.setHeader('Content-Type', response.headers['content-type']);
            }
            return res.status(response.status).send(Buffer.from(response.data));
        }

        res.status(response.status).json(response.data);
    } catch (error) {
        statusCode = error.response?.status || 500;
        console.error('TMDB API error:', error);

        await recordApiCall({
            calledAt: new Date().toISOString(),
            method: req.method,
            path: fullPath,
            status: statusCode,
            cacheHit,
            durationMs: Date.now() - startedAt,
            error: error.message
        });

        res.status(statusCode).json({
            error: error.message,
            details: error.response?.data
        });
    }
};
