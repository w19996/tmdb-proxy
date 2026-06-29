const assert = require('assert');
const Module = require('module');

process.env.KV_REST_API_URL = 'https://example.upstash.io';
process.env.KV_REST_API_TOKEN = 'token';

const redis = {
    strings: new Map(),
    hashes: new Map(),
    lists: new Map()
};

function hash(key) {
    if (!redis.hashes.has(key)) {
        redis.hashes.set(key, new Map());
    }
    return redis.hashes.get(key);
}

function list(key) {
    if (!redis.lists.has(key)) {
        redis.lists.set(key, []);
    }
    return redis.lists.get(key);
}

function runRedis(command) {
    const [name, key, first, second] = command;

    switch (name) {
        case 'INCR':
            redis.strings.set(key, String(Number(redis.strings.get(key) || 0) + 1));
            return redis.strings.get(key);
        case 'GET':
            return redis.strings.get(key) || null;
        case 'DEL':
            for (const redisKey of command.slice(1)) {
                redis.strings.delete(redisKey);
                redis.hashes.delete(redisKey);
                redis.lists.delete(redisKey);
            }
            return command.length - 1;
        case 'HINCRBY': {
            const entry = hash(key);
            entry.set(first, String(Number(entry.get(first) || 0) + Number(second)));
            return entry.get(first);
        }
        case 'HSET':
            hash(key).set(first, second);
            return 1;
        case 'HGETALL':
            return Object.fromEntries(hash(key));
        case 'LPUSH':
            list(key).unshift(first);
            return list(key).length;
        case 'LTRIM':
            redis.lists.set(key, list(key).slice(Number(first), Number(second) + 1));
            return 'OK';
        case 'LRANGE':
            return list(key).slice(Number(first), Number(second) + 1);
        case 'EXPIRE':
            return 1;
        default:
            throw new Error(`Unknown Redis command ${name}`);
    }
}

const originalLoad = Module._load;
let upstreamGets = 0;

Module._load = function load(request, parent, isMain) {
    if (request === 'axios') {
        return {
            get: async (url, config) => {
                upstreamGets += 1;
                assert.strictEqual(url, 'https://image.tmdb.org/t/p/w500/a.jpg');
                assert.deepStrictEqual(config, { responseType: 'arraybuffer' });
                return {
                    status: 200,
                    data: Buffer.from([1, 2, 3]),
                    headers: { 'content-type': 'image/jpeg' }
                };
            },
            post: async (url, commands) => {
                assert.strictEqual(url, 'https://example.upstash.io/pipeline');
                return {
                    data: commands.map((command) => ({ result: runRedis(command) }))
                };
            }
        };
    }

    return originalLoad.apply(this, arguments);
};

const handler = require('./tmdb.js');

function makeRes() {
    return {
        headers: {},
        statusCode: 0,
        body: null,
        setHeader(key, value) { this.headers[key] = value; },
        status(code) { this.statusCode = code; return this; },
        send(value) { this.body = value; return this; },
        json(value) { this.body = value; return this; },
        end() { return this; }
    };
}

async function request(url, method = 'GET') {
    const response = makeRes();
    await handler({ method, url, headers: {} }, response);
    return response;
}

(async () => {
    const firstImage = await request('/t/p/w500/a.jpg');
    const cachedImage = await request('/t/p/w500/a.jpg');
    const stats = await request('/admin/data');
    const clear = await request('/admin/clear', 'POST');
    const clearedStats = await request('/admin/data');

    assert.strictEqual(firstImage.statusCode, 200);
    assert.strictEqual(cachedImage.statusCode, 200);
    assert.strictEqual(clear.statusCode, 200);
    assert.strictEqual(firstImage.headers['Content-Type'], 'image/jpeg');
    assert.deepStrictEqual([...cachedImage.body], [1, 2, 3]);
    assert.strictEqual(upstreamGets, 1);
    assert.strictEqual(stats.body.storageMode, 'kv');
    assert.strictEqual(stats.body.total, 2);
    assert.strictEqual(stats.body.byPath[0].path, '/t/p/w500/a.jpg');
    assert.strictEqual(stats.body.byPath[0].count, 2);
    assert.strictEqual(clear.body.storageMode, 'kv');
    assert.strictEqual(clear.body.total, 0);
    assert.deepStrictEqual(clear.body.calls, []);
    assert.strictEqual(clearedStats.body.total, 0);
    assert.deepStrictEqual(clearedStats.body.byPath, []);

    console.log('tmdb proxy kv stats ok');
    process.exit(0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
