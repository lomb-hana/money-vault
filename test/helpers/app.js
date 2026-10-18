// Starts the real server.js in a child process against a throwaway JSON data file.
// Usage: const app = await startApp({ PLAID_API_BASE: ... }); const A = app.client(); ... app.stop();
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startApp(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-test-'));
  const dataFile = path.join(dir, 'db.json');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const key = crypto.randomBytes(32).toString('base64');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: dataFile,
      BANK_LINK_KEY: key,
      BANK_MANUAL_GAP_SEC: '0',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_KEY: '',
      NODE_ENV: 'test',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', d => {
    stderr += d;
  });

  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + '/healthz')).ok) {
        break;
      }
    } catch {}
    if (i === 99) {
      child.kill();
      throw new Error('server did not start: ' + stderr);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // A tiny cookie-keeping JSON client: one per simulated browser/user.
  function client() {
    let cookie = '';
    return async (url, method = 'GET', body) => {
      const res = await fetch(base + url, {
        method,
        headers: { 'Content-Type': 'application/json', cookie },
        body: body && JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        cookie = setCookie.split(';')[0];
      }
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: res.status, j: json, text };
    };
  }

  return {
    base,
    key,
    dataFile,
    client,
    readData: () => fs.readFileSync(dataFile, 'utf8'),
    stderr: () => stderr,
    stop: () => {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { startApp, freePort };
