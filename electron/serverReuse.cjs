const http = require('node:http');

function normalizePort(port) {
  const value = parseInt(String(port || ''), 10);
  return Number.isInteger(value) && value > 0 ? value : 3456;
}

function getDashboardUrl(port) {
  return `http://localhost:${normalizePort(port)}`;
}

function isCompatibleServerInfo(info, expectedVersion, expectedPackageName) {
  return Boolean(
    info &&
    info.packageName === expectedPackageName &&
    String(info.version || '').replace(/^v/, '') === String(expectedVersion || '').replace(/^v/, '')
  );
}

function fetchJson(url, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (error) { reject(error); }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', reject);
  });
}

async function findCompatibleServer(preferredPort, expectedVersion, expectedPackageName) {
  const port = normalizePort(preferredPort);
  try {
    const info = await fetchJson(`${getDashboardUrl(port)}/api/app-info`);
    if (isCompatibleServerInfo(info, expectedVersion, expectedPackageName)) {
      return { port, dashboardUrl: info.dashboardUrl || getDashboardUrl(port), info };
    }
  } catch (_) {}
  return null;
}

module.exports = {
  fetchJson,
  findCompatibleServer,
  getDashboardUrl,
  isCompatibleServerInfo,
  normalizePort,
};
