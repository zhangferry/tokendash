const { spawn } = require('node:child_process');

function normalizeVersion(version) {
  return String(version || '').trim().replace(/^v/, '');
}

function shouldInstallPackage(installedVersion, targetVersion) {
  const installed = normalizeVersion(installedVersion);
  const target = normalizeVersion(targetVersion);
  return Boolean(target) && installed !== target;
}

function buildNpmInstallArgs(packageName, version) {
  return ['install', '-g', `${packageName}@${version}`];
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolve({ ok: false, stdout, stderr, error }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

async function getInstalledPackageVersion(packageName) {
  const result = await runCommand('npm', ['list', '-g', packageName, '--depth=0', '--json']);
  if (!result.ok) return null;
  try {
    const data = JSON.parse(result.stdout);
    return normalizeVersion(data && data.dependencies && data.dependencies[packageName] && data.dependencies[packageName].version);
  } catch (_) {
    return null;
  }
}

async function syncNpmPackageVersion(packageName, version) {
  const installedVersion = await getInstalledPackageVersion(packageName);
  if (!shouldInstallPackage(installedVersion, version)) {
    return { ok: true, installedVersion, targetVersion: version, changed: false };
  }

  const result = await runCommand('npm', buildNpmInstallArgs(packageName, version));
  return {
    ok: result.ok,
    installedVersion,
    targetVersion: version,
    changed: result.ok,
    error: result.ok ? null : (result.error ? result.error.message : result.stderr || `npm exited with ${result.code}`),
  };
}

module.exports = {
  buildNpmInstallArgs,
  getInstalledPackageVersion,
  shouldInstallPackage,
  syncNpmPackageVersion,
};
