const debug            = require('debug')('express-idempotency');
const connect          = require('connect');
const expressEnd       = require('express-end');
const redis            = require('redis');
const promisifyAll     = require('util-promisifyAll');

const cache            = require('./lib/cache-provider');
const generateCacheKey = require('./lib/generate-cache-key');

/**
 * Express middleware
 * @param {*} req
 * @param {*} res
 * @param {*} next
 */
const checkInLRUCacheMw = (req, res, next) => {
    const idempotencyKey = req.get('Idempotency-Key');

    if (!idempotencyKey) {
        return next();
    }

    const cacheKey       = generateCacheKey(req, idempotencyKey);
    const storedResponse = cache.get(cacheKey);

    if (!storedResponse) {
        return next();
    }

    res.status(storedResponse.statusCode);
    res.set(storedResponse.headers);
    res.set('X-Cache', 'HIT'); // indicate this was served from cache
    res.send(storedResponse.body);
}

/**
 * Express middleware to store a response against a supplied idempotency token
 * in the cache.
 * @param {object} req Express request
 * @param {object} res Express response
 * @param {function} next Express next callback function
 */
const storeInLRUCacheMw = (req, res, next) => {
    res.once('end', () => {
        const idempotencyKey = req.get('Idempotency-Key');

        if (idempotencyKey) {
            const responseToStore = {
                statusCode: res.statusCode,
                body: res.body,
                headers: res.headers,
            };

            const cacheKey = generateCacheKey(req, idempotencyKey);
            cache.set(cacheKey, responseToStore)
            debug('stored response against idempotency key in cache: ', idempotencyKey);
        }
    });

    return next();
}

/**
 * Express middleware
 * @param {*} req
 * @param {*} res
 * @param {*} next
 */
const checkInRedisMw = (client_) => {
    const client = promisifyAll(client_);

    return async (req, res, next) => {
        const idempotencyKey = req.get('Idempotency-Key');

        if (!idempotencyKey) {
            return next();
        }

        const cacheKey       = generateCacheKey(req, idempotencyKey);
        const storedResponse = await client.getAsync(cacheKey, redis.print);

        if (!storedResponse) {
            return next();
        }

        res.status(storedResponse.statusCode);
        res.set(storedResponse.headers);
        res.set('X-Cache', 'HIT'); // indicate this was served from cache
        res.send(storedResponse.body);
    }
}

const storeInRedisMw = (client_) => {
    const client = promisifyAll(client_);

    return async (req, res, next) => {
        res.once('end', async () => {
            const idempotencyKey = req.get('Idempotency-Key');

            if (idempotencyKey) {
                const responseToStore = {
                    statusCode: res.statusCode,
                    body      : res.body,
                    headers   : res.headers,
                };

                const cacheKey = generateCacheKey(req, idempotencyKey);
                await client.setAsync(cacheKey, responseToStore, redis.print);
                debug('stored response against idempotency key in redis: ', idempotencyKey);
            }
        });

        return next();
    }
}

/**
 * Main middleware used to make requests idempotent by storing an uid in a cache engine
 * @param {object} cacheEngine 'lru' or 'redis'
 */
const idempotency = (options) => {
    if (options.cacheEngine !== 'lru' && options.cacheEngine !== 'redis') {
        throw TypeError('Unknown cacheEngine ' + options.cacheEngine + '. Must be either "lru" or "redis".');
    }

    // chain pattern from helmet - see https://github.com/helmetjs/helmet/blob/master/index.js
    const chain = connect();
    chain.use(expressEnd);
    if (options.cacheEngine === 'lru') {
        chain.use(checkInLRUCacheMw);
        chain.use(storeInLRUCacheMw);
    } else if (options.cacheEngine == 'redis') {
        chain.use(checkInRedisMw(options.redis.client));
        chain.use(storeInRedisMw(options.redis.client));
    }

    return chain;
}

module.exports = idempotency;
