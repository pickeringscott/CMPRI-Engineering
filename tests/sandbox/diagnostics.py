"""Local-only browser helpers with safe, bounded log output."""
import json
import re
import urllib.parse

LANDING_PATHS = {'/engineering', '/technician', '/work-orders'}

def is_login_landing(url):
    parsed = urllib.parse.urlparse(url)
    return parsed.hostname in {'127.0.0.1', 'localhost'} and parsed.path in LANDING_PATHS

def sanitize(value, secrets=()):
    text = json.dumps(value)
    for secret in secrets:
        if secret:
            text = text.replace(json.dumps(secret)[1:-1], '[redacted]')
    text = re.sub(r'[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}', '[redacted email]', text, flags=re.I)
    text = re.sub(r'sb_(?:secret|publishable)_[\w-]+', '[redacted key]', text)
    text = re.sub(r'eyJ[\w-]+\.[\w-]+\.[\w-]+', '[redacted JWT]', text)
    text = re.sub(r'(?i)(bearer\s+)[^\s"\\]+', r'\1[redacted]', text)
    text = re.sub(r'(?i)((?:access_token|refresh_token|password|api_key)=)[^&\s"\\]+', r'\1[redacted]', text)
    return json.loads(text)

def emit_result(result, secrets=()):
    fields = ['role', 'storedRole', 'phase', 'scenario', 'passed', 'status', 'httpStatus', 'errorType', 'error', 'blockedExternal', 'browserErrors']
    diagnostic = {key: result[key] for key in fields if key in result}
    if 'rows' in result:
        diagnostic['savedRowCount'] = len(result['rows'])
    safe = sanitize(diagnostic, secrets)
    if 'error' in safe:
        safe['error'] = str(safe['error'])[:2000]
    print(json.dumps(safe), flush=True)


def local_secrets(out):
    from pathlib import Path
    secrets=[]
    for name in ['local-keys.json','synthetic-users.json']:
        path=Path(out)/name
        if not path.exists(): continue
        value=json.loads(path.read_text())
        if isinstance(value,list):
            for user in value: secrets.extend([user.get('password',''),user.get('email','')])
        else:
            secrets.extend(v for k,v in value.items() if re.search('key|secret|password|token',k,re.I) and isinstance(v,str))
    return secrets
