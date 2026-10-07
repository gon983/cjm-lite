#!/usr/bin/env python3
"""End-to-end verification in its own disposable Compose project; standard library only."""
import concurrent.futures, threading, html, http.cookiejar, io, os, re, secrets, subprocess, tempfile, time, urllib.error, urllib.parse, urllib.request, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = 'http://localhost:18090'
env = {**os.environ, 'PORT': '18090', 'PUBLIC_URL': BASE, 'APP_ENV': 'development', 'SESSION_SECRET': ''}
override = tempfile.NamedTemporaryFile(mode='w', suffix='.yml', delete=False)
override.write('services:\n  app:\n    image: cjm-lite-app:latest\n')
override.close()
compose = ['docker', 'compose', '-p', 'cjm-lite-smoke', '-f', str(ROOT / 'docker-compose.yml'), '-f', override.name]

def dc(*args, **kw):
    return subprocess.run([*compose, *args], cwd=ROOT, env=env, check=True, **kw)

class Client:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
    def request(self, path, data=None, content_type=None, expect=200):
        req = urllib.request.Request(BASE + path, data=data, headers={'Origin': BASE} if data is not None else {})
        if content_type: req.add_header('Content-Type', content_type)
        try: response = self.opener.open(req, timeout=30)
        except urllib.error.HTTPError as exc: response = exc
        body = response.read()
        assert response.code == expect, (path, response.code, body.decode(errors='replace')[:500])
        return body
    def get(self, path): return self.request(path).decode()
    def post(self, path, values, page=None, files=None, expect=200):
        page = page or self.get('/')
        match = re.search(r'name="csrf" value="([a-f0-9]+)"', page)
        assert match, 'CSRF field missing'
        values = {**values, 'csrf': match[1]}
        for key in ('date','from','to'):
            if key in values and re.fullmatch(r'\d{4}-\d{2}-\d{2}',str(values[key])): values[key]='/'.join(str(values[key]).split('-')[::-1])
        if files:
            boundary = 'cjm' + secrets.token_hex(12)
            body = bytearray()
            for key, val in values.items():
                body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{val}\r\n'.encode())
            for key, (filename, mime, content) in files.items():
                body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"; filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'.encode())
                body.extend(content); body.extend(b'\r\n')
            body.extend(f'--{boundary}--\r\n'.encode())
            return self.request(path, bytes(body), f'multipart/form-data; boundary={boundary}', expect)
        return self.request(path, urllib.parse.urlencode(values).encode(), 'application/x-www-form-urlencoded', expect)
    def login(self, username, password):
        self.post('/login', {'username': username, 'password': password}, self.get('/login'))


def xlsx():
    from xml.sax.saxutils import escape
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        z.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Mediadores" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        rows = [['Apellido','Nombre','DNI','','','','','Email'], ['Perez','Ana','12345','','','','','ana@example.com'], ['Garcia','Juan','67890','','','','','juan@example.com']]
        xml = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
        for n, row in enumerate(rows, 1):
            xml += f'<row r="{n}">' + ''.join(f'<c r="{chr(65+i)}{n}" t="inlineStr"><is><t>{escape(v)}</t></is></c>' for i, v in enumerate(row)) + '</row>'
        z.writestr('xl/worksheets/sheet1.xml', xml + '</sheetData></worksheet>')
    return out.getvalue()


def main():
    dc('up', '-d', '--no-build', stdout=subprocess.DEVNULL)
    for _ in range(60):
        try:
            if urllib.request.urlopen(BASE + '/healthz', timeout=1).status == 200: break
        except Exception: time.sleep(1)
    else: raise AssertionError('Server did not start')
    password = secrets.token_urlsafe(24)
    dc('exec', '-T', 'app', '/app', 'create-admin', 'Test Admin', 'test-admin', input=(password+'\n').encode(), stdout=subprocess.DEVNULL)
    admin = Client(); admin.login('test-admin', password)
    assert 'Dashboard' in admin.get('/')
    admin.post('/admin/dnis',{'dni':'31.280.055','first':'Manual','last':'Perez','email':'manual@example.com'})
    assert 'Manual' in admin.get('/registro?dni=31280055')
    result = admin.post('/admin/importar', {}, admin.get('/admin/dnis'), files={'xlsx': ('input.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xlsx())}).decode()
    assert 'Importadas: 2' in result, result
    csv_content='Apellido;Nombre;DNI;Email\nCSV;Persona;32.280.055;csv@example.com\nApellido;Nombre;DNI;Email\n'.encode()
    csv_result=admin.post('/admin/importar',{},admin.get('/admin/dnis'),files={'xlsx':('csv-renamed.xlsx','text/csv',csv_content)}).decode()
    assert 'Importadas: 1' in csv_result and 'Encabezados omitidos: 2' in csv_result, csv_result
    assert 'Persona' in admin.get('/registro?dni=32.280.055')
    unicode_csv='Apellido\tNombre\tDNI\tEmail\r\nPérez\tMaría\t32280056\tmaria@example.com\r\n'.encode('utf-16-le')
    unicode_result=admin.post('/admin/importar',{},admin.get('/admin/dnis'),files={'xlsx':('unicode-no-bom.csv','text/csv',unicode_csv)}).decode()
    assert 'Importadas: 1' in unicode_result and 'Encabezados omitidos: 1' in unicode_result, unicode_result
    assert 'María' in admin.get('/registro?dni=32280056')


    # Valid tiny PNG generated with the stdlib.
    import struct, zlib
    def chunk(tag, data): return struct.pack('>I',len(data))+tag+data+struct.pack('>I',zlib.crc32(tag+data)&0xffffffff)
    photo=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',1,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b'\x00\x20\x50\x70'))+chunk(b'IEND',b'')
    first, second = Client(), Client()
    for client, mat in [(first,'12345'),(second,'67890')]:
        page=client.get('/registro?dni='+mat)
        client.post('/registro', {'dni':mat,'phone':'3511234567','password':password,'confirm':password},page,{'photo':('foto.png','image/png',photo)})
        client.login(mat,password)
    for route in ['/admin/mediaciones','/admin/usuarios','/admin/bloqueos','/admin/exportaciones','/admin/noticias','/admin/auditoria']:
        first.request(route, expect=403)
    calendar=first.get('/calendario')
    match=re.search(r'href="(/reservar\?[^\"]+)"',calendar);assert match, calendar
    path=html.unescape(match[1]); page=first.get(path)
    params=urllib.parse.parse_qs(urllib.parse.urlparse(path).query)
    m2=re.search(r'<option value="(\d+)">Garcia Juan',page)[1]
    values={'sede':params['sede'][0],'date':params['fecha'][0],'start':params['hora'][0],'m2':m2,'title':'Prueba operacional','case':'EXP-123'}
    first.post('/reservar',values,page)
    assert 'Prueba operacional' in second.get('/mis-mediaciones')
    day=admin.get('/admin/mediaciones?date='+values['date']);mid=re.search(r'/admin/editar\?id=(\d+)',day)[1]
    first.post('/cancelar',{'id':mid})
    assert 'Prueba operacional' not in second.get('/mis-mediaciones')
    first.post('/reservar',values)
    day=admin.get('/admin/mediaciones?date='+values['date']);mid=re.search(r'/admin/editar\?id=(\d+)',day)[1]
    admin.post('/admin/bloqueos',{'sede':'COSQUIN','date':values['date'],'reason':'Test closure'})
    assert 'CANCELADA_POR_ADMIN' in second.get('/mis-mediaciones')
    admin.post('/admin/bloqueos',{'sede':'COSQUIN','date':values['date'],'action':'unblock'})
    assert 'CANCELADA_POR_ADMIN' in second.get('/mis-mediaciones')
    first.post('/reservar',values)
    day=admin.get('/admin/mediaciones?date='+values['date']);ids=re.findall(r'/admin/editar\?id=(\d+)',day);mid=ids[-1]
    edit=admin.get('/admin/editar?id='+mid)
    m1=re.search(r'name="m1".*?<option value="(\d+)" selected',edit,re.S)[1]
    editvalues={**values,'id':mid,'m1':m1,'state':'FINALIZADA','result':''}
    admin.post('/admin/estado',editvalues,admin.get('/admin/estado?id='+mid),expect=400)
    editvalues['result']='CON_ACUERDO';admin.post('/admin/estado',editvalues)
    editvalues['state']='FIRMADA';admin.post('/admin/estado',editvalues)
    exported=admin.post('/admin/exportar',{'from':values['date'],'to':values['date']})
    with zipfile.ZipFile(io.BytesIO(exported)) as z: assert 'xl/worksheets/sheet1.xml' in z.namelist()
    admin.post('/admin/noticias',{'title':'Noticia de prueba','content':'Texto seguro <script>evil()</script>','date':values['date'],'published':'1'},files={'image':('foto.png','image/png',photo)})
    assert '<script>evil()</script>' not in second.get('/')
    # Concurrent authenticated reads, no polling.
    start=time.monotonic()
    barrier=threading.Barrier(100)
    def read(_):
        barrier.wait(timeout=15)
        req=urllib.request.Request(BASE+'/calendario', headers={'Cookie':'; '.join(c.name+'='+c.value for c in first.jar)})
        with urllib.request.urlopen(req,timeout=20) as r: assert r.status==200; r.read()
    with concurrent.futures.ThreadPoolExecutor(max_workers=100) as pool: list(pool.map(read,range(100)))
    print(f'100 lecturas concurrentes de calendario: {time.monotonic()-start:.2f} s')
    backup=dc('exec','-T','app','/app','backup',capture_output=True).stdout.decode().strip();assert backup.endswith('.tar.gz')
    # Browser can reuse these test accounts while this process is paused by the caller.
    print('Flujo HTTP completo: OK; importación, registro, reserva compartida, cancelación, bloqueo, estados, exportación, noticias y backup.')
    if os.getenv('CJM_BROWSER_STATE'):
        import json
        state={'base':BASE,'admin':[{'name':c.name,'value':c.value,'url':BASE} for c in admin.jar],'mediator':[{'name':c.name,'value':c.value,'url':BASE} for c in first.jar]}
        state_path=Path(os.environ['CJM_BROWSER_STATE']);state_path.write_text(json.dumps(state));state_path.chmod(0o600);time.sleep(45);state_path.unlink(missing_ok=True)

try:
    main()
finally:
    dc('down','-v',stdout=subprocess.DEVNULL)
    os.unlink(override.name)
