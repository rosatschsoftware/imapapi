'use strict';

require('dotenv').config();
try {
    process.chdir(__dirname);
} catch (err) {
    // ignore
}

process.title = 'imapapi';

// cache before wild-config
const argv = process.argv.slice(2);

const logger = require('./lib/logger');
const pathlib = require('path');
const { Worker, SHARE_ENV } = require('worker_threads');
const { redis } = require('./lib/db');
const promClient = require('prom-client');

const config = require('wild-config');

config.workers = config.workers || {
    imap: 4
};

const WORKERS_IMAP = Number(process.env.WORKERS_IMAP) || config.workers.imap;
logger.debug({ msg: 'IMAP Worker Count', workersImap: WORKERS_IMAP });

const metrics = {
    threadStarts: new promClient.Counter({
        name: 'thread_starts',
        help: 'Number of started threads'
    }),

    threadStops: new promClient.Counter({
        name: 'thread_stops',
        help: 'Number of stopped threads'
    }),

    apiCall: new promClient.Counter({
        name: 'api_call',
        help: 'Number of API calls',
        labelNames: ['method', 'statusCode', 'route']
    }),

    imapConnections: new promClient.Gauge({
        name: 'imap_connections',
        help: 'Current IMAP connection state',
        labelNames: ['status']
    })
};

let callQueue = new Map();
let mids = 0;

let closing = false;
let assigning = false;

let unassigned = false;
let assigned = new Map();
let workerAssigned = new WeakMap();

let workers = new Map();
let availableIMAPWorkers = new Set();

let spawnWorker = type => {
    if (closing) {
        return;
    }

    if (!workers.has(type)) {
        workers.set(type, new Set());
    }

    let worker = new Worker(pathlib.join(__dirname, 'workers', `${type}.js`), {
        argv,
        env: SHARE_ENV
    });
    metrics.threadStarts.inc();

    workers.get(type).add(worker);

    worker.on('exit', exitCode => {
        metrics.threadStops.inc();

        workers.get(type).delete(worker);
        availableIMAPWorkers.delete(worker);

        if (workerAssigned.has(worker)) {
            workerAssigned.get(worker).forEach(account => {
                assigned.delete(account);
                unassigned.add(account);
            });
            workerAssigned.delete(worker);
        }

        if (closing) {
            return;
        }

        // spawning a new worker trigger reassign
        logger.error({ msg: 'Worker exited', exitCode });
        setTimeout(() => spawnWorker(type), 1000);
    });

    worker.on('message', message => {
        if (!message) {
            return;
        }

        if (message.cmd === 'resp' && message.mid && callQueue.has(message.mid)) {
            let { resolve, reject, timer } = callQueue.get(message.mid);
            clearTimeout(timer);
            callQueue.delete(message.mid);
            if (message.error) {
                let err = new Error(message.error);
                if (message.code) {
                    err.code = message.code;
                }
                if (message.statusCode) {
                    err.statusCode = message.statusCode;
                }
                return reject(err);
            } else {
                return resolve(message.response);
            }
        }

        if (message.cmd === 'call' && message.mid) {
            return onCommand(worker, message.message)
                .then(response => {
                    worker.postMessage({
                        cmd: 'resp',
                        mid: message.mid,
                        response
                    });
                })
                .catch(err => {
                    worker.postMessage({
                        cmd: 'resp',
                        mid: message.mid,
                        error: err.message,
                        code: err.code,
                        statusCode: err.statusCode
                    });
                });
        }

        switch (message.cmd) {
            case 'metrics':
                if (message.key && metrics[message.key] && typeof metrics[message.key][message.method] === 'function') {
                    metrics[message.key][message.method](...message.args);
                }
                return;

            case 'settings':
                availableIMAPWorkers.forEach(worker => {
                    worker.postMessage(message);
                });
                return;
        }

        switch (type) {
            case 'imap':
                return processImapWorkerMessage(worker, message);
        }
    });
};

function processImapWorkerMessage(worker, message) {
    if (!message || !message.cmd) {
        logger.debug({ msg: 'Unexpected message', type: 'imap', message });

        return;
    }

    switch (message.cmd) {
        case 'ready':
            availableIMAPWorkers.add(worker);
            // assign pending accounts
            assignAccounts().catch(err => logger.error(err));
            break;
    }
}

async function call(worker, message, transferList) {
    return new Promise((resolve, reject) => {
        let mid = `${Date.now()}:${++mids}`;

        let timer = setTimeout(() => {
            let err = new Error('Timeout waiting for command response');
            err.statusCode = 504;
            err.code = 'Timeout';
            reject(err);
        }, message.timeout || 10 * 1000);

        callQueue.set(mid, { resolve, reject, timer });
        worker.postMessage(
            {
                cmd: 'call',
                mid,
                message
            },
            transferList
        );
    });
}

async function assignAccounts() {
    if (assigning) {
        return false;
    }
    assigning = true;
    try {
        if (!unassigned) {
            // first run
            // list all available accounts and assign to worker threads
            let accounts = await redis.smembers('ia:accounts');
            unassigned = new Set(accounts);
        }

        if (!availableIMAPWorkers.size || !unassigned.size) {
            // nothing to do here
            return;
        }

        let workerIterator = availableIMAPWorkers.values();
        let getNextWorker = () => {
            let next = workerIterator.next();
            if (next.done) {
                if (!availableIMAPWorkers.size) {
                    return false;
                }
                workerIterator = availableIMAPWorkers.values();
                return workerIterator.next().value;
            } else {
                return next.value;
            }
        };

        for (let account of unassigned) {
            let worker = getNextWorker();
            if (!worker) {
                // out of workers
                break;
            }

            if (!workerAssigned.has(worker)) {
                workerAssigned.set(worker, new Set());
            }
            workerAssigned.get(worker).add(account);
            assigned.set(account, worker);
            unassigned.delete(account);
            await call(worker, {
                cmd: 'assign',
                account
            });
        }
    } finally {
        assigning = false;
    }
}

async function onCommand(worker, message) {
    switch (message.cmd) {
        case 'metrics':
            return promClient.register.metrics();

        case 'structuredMetrics': {
            let connections = {};

            for (let key of Object.keys(metrics.imapConnections.hashMap)) {
                if (key.indexOf('status:') === 0) {
                    let metric = metrics.imapConnections.hashMap[key];
                    connections[metric.labels.status] = metric.value;
                }
            }
            return { connections };
        }

        case 'new':
            unassigned.add(message.account);
            assignAccounts().catch(err => logger.error(err));
            return;

        case 'delete':
            unassigned.delete(message.account); // if set
            if (assigned.has(message.account)) {
                let assignedWorker = assigned.get(message.account);
                if (workerAssigned.has(assignedWorker)) {
                    workerAssigned.get(assignedWorker).delete(message.account);
                }

                call(assignedWorker, message)
                    .then(() => logger.debug('worker processed'))
                    .catch(err => logger.error(err));
            }
            return;

        case 'update':
            if (assigned.has(message.account)) {
                let assignedWorker = assigned.get(message.account);
                call(assignedWorker, message)
                    .then(() => logger.debug('worker processed'))
                    .catch(err => logger.error(err));
            }
            return;

        case 'listMessages':
        case 'buildContacts':
        case 'getRawMessage':
        case 'getText':
        case 'getMessage':
        case 'updateMessage':
        case 'moveMessage':
        case 'deleteMessage':
        case 'createMailbox':
        case 'deleteMailbox':
        case 'submitMessage':
        case 'uploadMessage':
        case 'getAttachment': {
            if (!assigned.has(message.account)) {
                return {
                    error: 'No active connection to requested account. Try again later.',
                    statusCode: 503
                };
            }

            let assignedWorker = assigned.get(message.account);
            return await call(assignedWorker, message, message.port ? [message.port] : []);
        }
    }
    return 999;
}

// multiple IMAP connection handlers
for (let i = 0; i < WORKERS_IMAP; i++) {
    spawnWorker('imap');
}

// single worker for HTTP
spawnWorker('api');
spawnWorker('webhooks');

let metricsResult = {};
async function collectMetrics() {
    // reset all counters
    Object.keys(metricsResult || {}).forEach(key => {
        metricsResult[key] = 0;
    });

    if (workers.has('imap')) {
        let imapWorkers = workers.get('imap');
        for (let imapWorker of imapWorkers) {
            try {
                let workerStats = await call(imapWorker, { cmd: 'countConnections' });
                Object.keys(workerStats || {}).forEach(status => {
                    if (!metricsResult[status]) {
                        metricsResult[status] = 0;
                    }
                    metricsResult[status] += Number(workerStats[status]) || 0;
                });
            } catch (err) {
                logger.error(err);
            }
        }
    }

    Object.keys(metricsResult).forEach(status => {
        metrics.imapConnections.set({ status }, metricsResult[status]);
    });
}

setInterval(() => {
    collectMetrics().catch(err => logger.error({ msg: 'Failed to collect metrics', err }));
}, 5000).unref();

process.on('SIGTERM', () => {
    if (closing) {
        return;
    }
    closing = true;
    setImmediate(() => {
        process.exit();
    });
});

process.on('SIGINT', () => {
    if (closing) {
        return;
    }
    closing = true;
    setImmediate(() => {
        process.exit();
    });
});
