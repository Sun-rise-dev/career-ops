/**
 * 本机职位看板。只监听 127.0.0.1，不引入新依赖。
 *
 *   node job-board/server.mjs
 *   node job-board/server.mjs --open
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { flagValue, hasFlag, validateFlags } from '../lib/cli-flags.mjs';
import { parsePipeline } from './parse-pipeline.mjs';
import { blankStatus, loadStatus, updateJobStatus, StatusStoreError } from './status-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const MAX_BODY = 8192;

const FILES = {
  '/': { path: join(PUBLIC, 'index.html'), type: 'text/html; charset=utf-8' },
  '/app.css': { path: join(PUBLIC, 'app.css'), type: 'text/css; charset=utf-8' },
  '/app.js': { path: join(PUBLIC, 'app.js'), type: 'text/javascript; charset=utf-8' },
  '/board-view.mjs': { path: join(HERE, 'board-view.mjs'), type: 'text/javascript; charset=utf-8' },
};

/**
 * @param {string|undefined} address
 * @returns {boolean}
 */
export function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * @param {string} pipelinePath
 * @param {string} statusPath
 */
export function readBoard(pipelinePath, statusPath) {
  const text = existsSync(pipelinePath) ? readFileSync(pipelinePath, 'utf8') : '';
  const jobs = parsePipeline(text);
  const doc = loadStatus(statusPath);
  for (const job of jobs) {
    job.status = doc.byUrl[job.id] ? { ...doc.byUrl[job.id] } : blankStatus();
  }
  return { jobs, statusUpdatedAt: doc.updatedAt };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function sendFile(res, file) {
  const payload = readFileSync(file.path);
  res.writeHead(200, {
    'Content-Type': file.type,
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      const err = new Error(message);
      err.status = status;
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        fail(413, '提交的内容太长。');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        settled = true;
        resolveBody({});
        return;
      }
      try {
        const value = JSON.parse(text);
        if (value == null || typeof value !== 'object' || Array.isArray(value)) {
          fail(400, '提交的内容格式不对。');
          return;
        }
        settled = true;
        resolveBody(value);
      } catch {
        fail(400, '提交的内容不是 JSON。');
      }
    });
    req.on('error', () => fail(400, '提交中断了。'));
  });
}

/**
 * @param {object} options
 * @param {string} options.pipelinePath
 * @param {string} options.statusPath
 * @param {number} [options.port]
 * @param {string} [options.host]
 */
export function startJobBoard(options) {
  const host = options.host ?? HOST;
  if (host !== HOST) {
    return Promise.reject(new Error('职位看板只监听本机 127.0.0.1'));
  }
  const pipelinePath = options.pipelinePath;
  const statusPath = options.statusPath;
  let queue = Promise.resolve();

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent || res.writableEnded) return;
      const known = err instanceof StatusStoreError;
      const status = err.status || (known && err.code === 'INVALID' ? 400 : 500);
      const message = known || err.status ? err.message : '看板暂时出错，进度没有改动。';
      sendJson(res, status, { error: message });
    });
  });

  async function handle(req, res) {
    if (!isLoopback(req.socket.remoteAddress)) {
      sendJson(res, 403, { error: '只接受本机访问。' });
      return;
    }
    const url = new URL(req.url || '/', `http://${HOST}`);
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      const board = readBoard(pipelinePath, statusPath);
      sendJson(res, 200, board);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/status') {
      const body = await readBody(req);
      const run = queue.then(() => applyPost(body));
      queue = run.then(() => {}, () => {});
      const saved = await run;
      sendJson(res, 200, saved);
      return;
    }
    if (req.method === 'GET' && FILES[url.pathname]) {
      sendFile(res, FILES[url.pathname]);
      return;
    }
    sendJson(res, 404, { error: '没有这个页面。' });
  }

  function applyPost(body) {
    const board = readBoard(pipelinePath, statusPath);
    const id = typeof body.id === 'string' && body.id
      ? body.id
      : typeof body.url === 'string'
        ? board.jobs.find((job) => job.url === body.url || job.id === body.url)?.id
        : '';
    const job = board.jobs.find((item) => item.id === id);
    if (!job) {
      const err = new Error('列表里没有这条岗位。先刷新页面。');
      err.status = 404;
      throw err;
    }
    const patch = {};
    for (const field of ['applied', 'contacted', 'interview', 'result']) {
      if (Object.prototype.hasOwnProperty.call(body, field)) patch[field] = body[field];
    }
    const status = updateJobStatus(statusPath, job.id, patch);
    return { id: job.id, status };
  }

  return new Promise((resolveListen, rejectListen) => {
    const onError = (err) => rejectListen(err);
    server.once('error', onError);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', onError);
      const port = server.address().port;
      resolveListen({
        server,
        port,
        url: `http://${HOST}:${port}/`,
        close() {
          return new Promise((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          });
        },
      });
    });
  });
}

/**
 * @param {string} url
 */
export function openBrowser(url) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // 打不开浏览器时看板本身仍在运行。
  }
}

const USAGE = `用法:
  node job-board/server.mjs
  node job-board/server.mjs --open
  node job-board/server.mjs --port 8787 --pipeline data/pipeline.md --status data/job-board-status.json

只监听 127.0.0.1。岗位来自 pipeline.md，进度写在 job-board-status.json。`;

const KNOWN_FLAGS = ['--port', '--pipeline', '--status', '--open', '--help', '-h'];
const VALUE_FLAGS = ['--port', '--pipeline', '--status'];

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  const root = getCareerOpsRoot();
  const pipelineFlag = flagValue(args, '--pipeline');
  const statusFlag = flagValue(args, '--status');
  const portFlag = flagValue(args, '--port');
  let port = DEFAULT_PORT;
  if (portFlag !== undefined) {
    if (!/^\d+$/.test(portFlag) || Number(portFlag) < 1 || Number(portFlag) > 65535) {
      console.error('端口必须是 1 到 65535 的整数。');
      process.exit(1);
    }
    port = Number(portFlag);
  }
  const pipelinePath = pipelineFlag ? resolve(pipelineFlag) : join(root, 'data', 'pipeline.md');
  const statusPath = statusFlag ? resolve(statusFlag) : join(root, 'data', 'job-board-status.json');
  const open = hasFlag(args, '--open');

  startJobBoard({ pipelinePath, statusPath, port, host: HOST }).then((board) => {
    console.log(`职位看板：${board.url}`);
    console.log('关掉这个窗口就会停止。进度保存在本机，下次打开还在。');
    if (open) openBrowser(board.url);
  }).catch((err) => {
    if (err?.code === 'EADDRINUSE') {
      const url = `http://${HOST}:${port}/`;
      console.log(`看板已经在运行：${url}`);
      if (open) openBrowser(url);
      process.exit(0);
    }
    console.error(err?.message || err);
    process.exit(1);
  });
}
