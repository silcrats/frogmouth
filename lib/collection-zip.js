const fs = require('fs');
const os = require('os');
const path = require('path');
const { Transform } = require('stream');
const { finished, pipeline } = require('stream/promises');
const yazl = require('yazl');

// ---------------------------------------------------------------------
// Streams a set of documents to the browser as one zip file. Each file is
// fetched to a temporary file before it's added: a fetch can fail partway,
// and that has to leave it out of the zip rather than break the zip. So a
// download needs temporary disk space for one file at a time, not for all
// of them. What couldn't be included is listed in a report inside the zip.
// ---------------------------------------------------------------------
const REPORT_NAME = '_not-included.txt';
const MAX_NAME_CHARS = 200;

// An indexed file name as one safe zip entry name: never a path (a name is
// document metadata, and unzipping shouldn't write outside its folder), and
// valid on Windows, where these zips will mostly be opened.
function safeEntryName(name) {
  let safe = String(name || '')
    .replace(/[/\\:*?"<>|\x00-\x1f\x7f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(safe)) safe = `_${safe}`;
  if (safe.length > MAX_NAME_CHARS) {
    const ext = path.extname(safe).slice(0, 20);
    safe = safe.slice(0, MAX_NAME_CHARS - ext.length) + ext;
  }
  return safe || 'document';
}

// Different folders can hold files of the same name; a zip here is flat, so
// the later ones become "name (2).ext". Ignores case, as Windows does.
function uniqueNames(names) {
  const used = new Set([REPORT_NAME.toLowerCase()]);
  return names.map(name => {
    const safe = safeEntryName(name);
    const ext = path.extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    let candidate = safe;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

// Fails the fetch of a file that would take the download over its limit.
class TooLarge extends Error {}
function byteLimit(remaining, onBytes) {
  let seen = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      seen += chunk.length;
      if (seen > remaining) return done(new TooLarge());
      onBytes(chunk.length);
      done(null, chunk);
    },
  });
}

function reportText({ failed, tooLarge, linked }) {
  const section = (heading, lines) => (lines.length ? `${heading}\n${lines.map(l => `  ${l}`).join('\n')}\n\n` : '');
  return section('Could not be read from the file share:', failed)
    + section('Left out to keep the download within its size limit:', tooLarge)
    + section('Not files that can be downloaded; open them with these links:', linked);
}

// files: [{ id, name, mtime (a Date, optional) }]. open(id) returns a readable
// stream of a file, or throws. linked: lines for the report. Resolves once the
// response is finished, or the browser has gone away.
async function streamCollectionZip({ files, linked, open, maxBytes, res }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frogmouth-zip-'));
  const zip = new yazl.ZipFile();
  const report = { failed: [], tooLarge: [], linked };
  let gone = false;
  let current = null;
  let total = 0;
  const onClose = () => {
    gone = !res.writableFinished;
    if (gone && current) current.destroy();
  };
  res.on('close', onClose);
  zip.on('error', err => {
    console.error('Collection zip error:', err.message);
    res.destroy();
  });
  zip.outputStream.pipe(res);

  const names = uniqueNames(files.map(f => f.name));
  try {
    for (const [i, file] of files.entries()) {
      if (gone) return;
      const tmp = path.join(dir, String(i));
      try {
        current = open(file.id);
        await pipeline(current, byteLimit(maxBytes - total, n => { total += n; }), fs.createWriteStream(tmp));
      } catch (err) {
        if (gone) return;
        if (err instanceof TooLarge) {
          report.tooLarge.push(names[i]);
        } else {
          console.error('Collection zip: could not fetch', file.id, '-', err.message);
          report.failed.push(names[i]);
        }
        fs.rmSync(tmp, { force: true });
        continue;
      }
      await new Promise((resolve, reject) => {
        current = fs.createReadStream(tmp);
        current.once('close', resolve);
        current.once('error', reject);
        zip.addReadStream(current, names[i], { ...(file.mtime && { mtime: file.mtime }) });
      });
      fs.rmSync(tmp, { force: true });
    }
    if (gone) return;
    const text = reportText(report);
    if (text) zip.addBuffer(Buffer.from(text), REPORT_NAME);
    zip.end();
    await finished(res).catch(() => {});
  } catch (err) {
    // Too late for an error response: only a dropped connection says the
    // zip is incomplete.
    console.error('Collection zip failed:', err.message);
    res.destroy();
  } finally {
    res.off('close', onClose);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { streamCollectionZip, safeEntryName, uniqueNames };
