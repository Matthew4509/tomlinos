# Makes test/fixtures/archives.json: real archives from Python's own zipfile/tarfile/gzip, for test/archive.test.ts.
# Run from the desktop folder: python test/fixtures/make-archives.py
import base64, gzip, io, json, tarfile, zipfile

z = io.BytesIO()
with zipfile.ZipFile(z, 'w', zipfile.ZIP_DEFLATED) as f:
    f.writestr('docs/', '')
    f.writestr('docs/a.txt', 'hello ' * 100)
    f.writestr('b.bin', bytes(range(256)), compress_type=zipfile.ZIP_STORED)
    f.writestr('../../evil.txt', 'x')
    f.writestr('C:\\win\\x.txt', 'y')

t = io.BytesIO()
with tarfile.open(fileobj=t, mode='w', format=tarfile.GNU_FORMAT) as f:
    for name, data in [('dir/one.txt', b'one'), ('/abs/' + 'L' * 120 + '.txt', b'long')]:
        info = tarfile.TarInfo(name)
        info.size = len(data)
        f.addfile(info, io.BytesIO(data))
    link = tarfile.TarInfo('link')
    link.type = tarfile.SYMTYPE
    link.linkname = '/etc/passwd'
    f.addfile(link)

bomb = io.BytesIO()
with zipfile.ZipFile(bomb, 'w', zipfile.ZIP_DEFLATED) as f:
    f.writestr('big', b'\0' * (210 * 1024 * 1024))

out = dict(zip=z.getvalue(), tar=t.getvalue(), tgz=gzip.compress(t.getvalue(), mtime=0),
           gz=gzip.compress(b'plain text', mtime=0), bomb=bomb.getvalue())
with open('test/fixtures/archives.json', 'w') as f:
    json.dump({k: base64.b64encode(v).decode() for k, v in out.items()}, f)
