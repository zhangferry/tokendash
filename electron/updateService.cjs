const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

function fetchHttpsJson(url) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const reqOpts = {
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'TokenDash',
      },
    };

    https.get(reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function fetchLatestReleaseUrl(repo) {
  const url = `https://github.com/${repo}/releases/latest`;
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const reqOpts = {
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      method: 'HEAD',
      headers: {
        'User-Agent': 'TokenDash',
      },
    };

    https.request(reqOpts, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        resolve(new URL(res.headers.location, url).toString());
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      resolve(url);
    }).on('error', reject).end();
  });
}

function compareVersions(a, b) {
  const aParts = String(a).replace(/^v/, '').split(/[.-]/).map((part) => parseInt(part, 10) || 0);
  const bParts = String(b).replace(/^v/, '').split(/[.-]/).map((part) => parseInt(part, 10) || 0);
  const maxLen = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < maxLen; i++) {
    const delta = (aParts[i] || 0) - (bParts[i] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function isDmgAsset(asset) {
  return Boolean(asset && typeof asset.name === 'string' && /\.dmg$/i.test(asset.name));
}

function selectMacDmgAsset(assets, arch = process.arch) {
  const dmgAssets = (Array.isArray(assets) ? assets : []).filter(isDmgAsset);
  if (dmgAssets.length === 0) return null;

  const archNeedle = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : '';
  if (archNeedle) {
    const archMatch = dmgAssets.find((asset) => asset.name.toLowerCase().includes(archNeedle));
    if (archMatch) return archMatch;
  }

  const universal = dmgAssets.find((asset) => /universal/i.test(asset.name));
  return universal || dmgAssets[0];
}

function getReleaseUpdateInfo(release, currentVersion, arch = process.arch) {
  const tag = String((release && release.tag_name) || '').replace(/^v/, '');
  const latestVersion = tag || currentVersion;
  const asset = selectMacDmgAsset(release && release.assets, arch);
  const upToDate = compareVersions(currentVersion, latestVersion) >= 0;

  return {
    currentVersion,
    latestVersion,
    upToDate,
    releaseUrl: (release && release.html_url) || null,
    asset: asset ? {
      name: asset.name,
      size: Number(asset.size) || 0,
      url: asset.browser_download_url,
    } : null,
  };
}

function buildDmgAssetFromVersion(repo, tagName, arch = process.arch) {
  const version = String(tagName || '').replace(/^v/, '');
  const archSuffix = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : 'universal';
  const name = `TokenDash-${version}-${archSuffix}.dmg`;

  return {
    name,
    size: 0,
    url: `https://github.com/${repo}/releases/download/${tagName}/${name}`,
  };
}

function getRedirectReleaseUpdateInfo(repo, releaseUrl, currentVersion, arch = process.arch) {
  const parsedUrl = new URL(releaseUrl);
  const tagMatch = parsedUrl.pathname.match(/\/releases\/tag\/([^/]+)\/?$/);
  if (!tagMatch) throw new Error('Unable to determine the latest release tag.');

  const tagName = decodeURIComponent(tagMatch[1]);
  const latestVersion = tagName.replace(/^v/, '');
  const upToDate = compareVersions(currentVersion, latestVersion) >= 0;

  return {
    currentVersion,
    latestVersion,
    upToDate,
    releaseUrl: parsedUrl.toString(),
    asset: upToDate ? null : buildDmgAssetFromVersion(repo, tagName, arch),
  };
}

async function checkForUpdates({
  repo,
  currentVersion,
  arch = process.arch,
  fetchReleaseJson = fetchHttpsJson,
  fetchLatestReleaseUrl: fetchLatestReleaseUrlOverride = fetchLatestReleaseUrl,
}) {
  try {
    const release = await fetchReleaseJson(`https://api.github.com/repos/${repo}/releases/latest`);
    return getReleaseUpdateInfo(release, currentVersion, arch);
  } catch (error) {
    const releaseUrl = await fetchLatestReleaseUrlOverride(repo);
    return getRedirectReleaseUpdateInfo(repo, releaseUrl, currentVersion, arch);
  }
}

function safeDownloadName(name) {
  return path.basename(String(name || 'TokenDash-update.dmg')).replace(/[^\w .()+@-]/g, '-');
}

function downloadFile(url, destination, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    let received = 0;

    const request = https.get(url, { headers: { 'User-Agent': 'TokenDash' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close(() => fs.rm(destination, { force: true }, () => {}));
        downloadFile(res.headers.location, destination, onProgress).then(resolve, reject);
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        file.close(() => fs.rm(destination, { force: true }, () => {}));
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const total = Number(res.headers['content-length']) || 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (typeof onProgress === 'function') {
          onProgress({ received, total, percent: total > 0 ? Math.round((received / total) * 100) : null });
        }
      });
      res.pipe(file);
    });

    request.on('error', (error) => {
      file.close(() => fs.rm(destination, { force: true }, () => {}));
      reject(error);
    });

    file.on('finish', () => {
      file.close(() => resolve(destination));
    });

    file.on('error', (error) => {
      file.close(() => fs.rm(destination, { force: true }, () => {}));
      reject(error);
    });
  });
}

async function downloadUpdateAsset(asset, downloadsDir, onProgress) {
  if (!asset || !asset.url) throw new Error('No downloadable macOS update asset was found.');
  fs.mkdirSync(downloadsDir, { recursive: true });
  const destination = path.join(downloadsDir, safeDownloadName(asset.name));
  await downloadFile(asset.url, destination, onProgress);
  return destination;
}

module.exports = {
  checkForUpdates,
  compareVersions,
  downloadUpdateAsset,
  fetchLatestReleaseUrl,
  getRedirectReleaseUpdateInfo,
  getReleaseUpdateInfo,
  selectMacDmgAsset,
};
