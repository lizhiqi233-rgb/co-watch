const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

function createExtensionService(extensionRoot) {
  let manifestVersionCache = '';
  let manifestMtimeMs = null;

  function readExtensionManifestVersion() {
    const manifestPath = path.join(extensionRoot, 'manifest.json');
    try {
      const mtimeMs = fs.statSync(manifestPath).mtimeMs;
      if (manifestMtimeMs === mtimeMs) return manifestVersionCache;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifestVersionCache =
        typeof manifest.version === 'string' ? manifest.version.trim() : '';
      manifestMtimeMs = mtimeMs;
      return manifestVersionCache;
    } catch (_) {
      manifestVersionCache = '';
      manifestMtimeMs = null;
      return '';
    }
  }

  function sanitizeVersionInZipPath(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (!text || text.length > 64) return '';
    if (!/^[\w.\-+]+$/i.test(text)) return '';
    return text;
  }

  function serveExtensionZip(res, versionFromPath) {
    if (!fs.existsSync(extensionRoot)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('extension folder missing (configure EXTENSION_DIR)');
      return;
    }

    const manifestRaw = readExtensionManifestVersion().trim();
    const manifestVersion = manifestRaw || 'unknown';
    if (versionFromPath != null && versionFromPath !== '') {
      const pathVersion = sanitizeVersionInZipPath(versionFromPath);
      if (!pathVersion || pathVersion !== manifestVersion) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('extension zip: path version does not match current manifest');
        return;
      }
    }

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="co-watch-extension-${manifestVersion}.zip"`,
      'Cache-Control': 'no-store',
    });
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', () => {
      try {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(500);
        res.end();
      } catch (_) {}
    });
    archive.pipe(res);
    archive.directory(extensionRoot, false);
    archive.finalize();
  }

  function handleHttpRequest(req, res) {
    let pathname = (req.url || '').split('?')[0];
    try {
      pathname = decodeURIComponent(pathname);
    } catch (_) {}

    if (pathname === '/health' || pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('co-watch room server ok');
      return;
    }
    if (req.method === 'GET' && pathname === '/extension.zip') {
      serveExtensionZip(res, null);
      return;
    }
    if (req.method === 'GET') {
      const match = pathname.match(/^\/extension-([^/]+)\.zip$/i);
      if (match) {
        serveExtensionZip(res, match[1]);
        return;
      }
    }
    res.writeHead(404);
    res.end();
  }

  return { handleHttpRequest, readExtensionManifestVersion };
}

module.exports = { createExtensionService };
