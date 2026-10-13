// Local-login detection for the Qoder desktop clients.
//
// Both clients persist their session in an Electron userData directory:
//   intl: %APPDATA%\com.qoder.app.stable\auth.v1.dat
//   cn:   %APPDATA%\com.qodercn.app.stable\auth.v1.dat
// The blob is Chromium's os_crypt format: b"v10" || iv(12) || ciphertext || tag(16),
// AES-256-GCM with a key wrapped by Windows DPAPI. The wrapped key lives in the
// same directory's "Local State" at .os_crypt.encrypted_key (base64, prefixed
// with the ASCII text "DPAPI"). Each app has its own key, so decrypt per dir.
//
// Plaintext shape:
//   { schemaVersion, token: "dt-...", refreshToken: "drt-...",
//     expiresAt: ISO, refreshTokenExpiresAt: ISO,
//     user: { id, name, email, phone, avatarUrl } }
//
// DPAPI unwrapping is the only non-portable step; it shells out to powershell.exe
// once per app dir and caches the result. Everything else is pure node crypto.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const APP_DIRS = {
  intl: 'com.qoder.app.stable',
  cn: 'com.qodercn.app.stable',
};

const keyCache = new Map();

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} failed: ${(stderr || err.message).toString().slice(0, 200)}`));
      resolve(stdout);
    });
  });
}

// Unwrap the DPAPI-protected AES key for one app dir.
async function dpapiKey(dir) {
  if (keyCache.has(dir)) return keyCache.get(dir);
  const lsPath = path.join(dir, 'Local State');
  if (!fs.existsSync(lsPath)) throw new Error(`Local State missing: ${lsPath}`);
  const ls = JSON.parse(fs.readFileSync(lsPath, 'utf8'));
  const encKeyB64 = ls?.os_crypt?.encrypted_key;
  if (!encKeyB64) throw new Error(`os_crypt.encrypted_key missing in ${lsPath}`);
  const encKey = Buffer.from(encKeyB64, 'base64');
  const wrapped = encKey.subarray(0, 5).toString('latin1') === 'DPAPI' ? encKey.subarray(5) : encKey;

  const tag = crypto.createHash('md5').update(dir).digest('hex').slice(0, 8);
  const inB64 = path.join(os.tmpdir(), `qoder-lk-${tag}.b64`);
  const script = path.join(os.tmpdir(), `qoder-lk-${tag}.ps1`);
  const outB64 = path.join(os.tmpdir(), `qoder-lk-${tag}-out.b64`);
  fs.writeFileSync(inB64, wrapped.toString('base64'), 'utf8');
  fs.writeFileSync(script, [
    'Add-Type -AssemblyName System.Security',
    `$b64 = Get-Content -LiteralPath '${inB64}' -Raw`,
    '$bytes = [Convert]::FromBase64String($b64.Trim())',
    '$out = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    `Set-Content -LiteralPath '${outB64}' -Value ([Convert]::ToBase64String($out)) -Encoding ascii -NoNewline`,
  ].join('\n'), 'utf8');

  await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]);
  const key = Buffer.from(fs.readFileSync(outB64, 'utf8').trim(), 'base64');
  for (const p of [inB64, script, outB64]) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  keyCache.set(dir, key);
  return key;
}

function decryptV10(buf, key) {
  if (buf.length < 3 + 12 + 16) throw new Error('auth blob too short');
  const iv = buf.subarray(3, 15);
  const tag = buf.subarray(buf.length - 16);
  const data = buf.subarray(15, buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

function appDataRoot() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

/**
 * Read the local Qoder session for a region without touching the network.
 * Returns null when the client is absent or the user is not signed in.
 */
export async function readLocalQoderAuth(product) {
  const dir = path.join(appDataRoot(), APP_DIRS[product === 'cn' ? 'cn' : 'intl']);
  const authFile = path.join(dir, 'auth.v1.dat');
  const midFile = path.join(dir, 'auth.machine-id');
  if (!fs.existsSync(authFile)) return null;
  try {
    const key = await dpapiKey(dir);
    const parsed = JSON.parse(decryptV10(fs.readFileSync(authFile), key));
    const token = parsed.token || '';
    const refresh = parsed.refreshToken || '';
    if (!token) return null;
    let machineId = '';
    try { machineId = fs.existsSync(midFile) ? fs.readFileSync(midFile, 'utf8').trim() : ''; } catch { /* ignore */ }
    const user = parsed.user && typeof parsed.user === 'object' ? parsed.user : {};
    return {
      source: 'local',
      product: product === 'cn' ? 'cn' : 'intl',
      securityOauthToken: token,
      accessToken: token,
      refreshToken: refresh,
      expireTime: parsed.expiresAt ? Date.parse(parsed.expiresAt) : 0,
      refreshTokenExpireTime: parsed.refreshTokenExpiresAt ? Date.parse(parsed.refreshTokenExpiresAt) : 0,
      machineId,
      uid: user.id || '',
      nickname: user.name || '',
      email: user.email || '',
      phone: user.phone || '',
      avatarUrl: user.avatarUrl || '',
    };
  } catch {
    return null;
  }
}

export function localAuthStatus(product) {
  const dir = path.join(appDataRoot(), APP_DIRS[product === 'cn' ? 'cn' : 'intl']);
  return {
    appDir: dir,
    installed: fs.existsSync(dir),
    signedIn: fs.existsSync(path.join(dir, 'auth.v1.dat')),
  };
}

export default { readLocalQoderAuth, localAuthStatus };
