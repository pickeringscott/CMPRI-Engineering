import hashlib,json,tomllib
from pathlib import Path
root=Path(__file__).resolve().parents[2]
manifest=json.loads((root/'tests/sandbox/release-manifest.json').read_text())
assert manifest['release']=='009a25000addefed5733415cf0a7c3656c59eb5c'
for name,digest in manifest['sha256'].items():
    assert hashlib.sha256((root/name).read_bytes()).hexdigest()==digest,name
assert {p.relative_to(root).as_posix() for d in ['src','supabase/migrations'] for p in (root/d).rglob('*') if p.is_file()} == {n for n in manifest['sha256'] if n.startswith(('src/','supabase/migrations/'))}
assert json.loads((root/'vercel.json').read_text())['git']['deploymentEnabled'] is False
cfg=tomllib.loads((root/'tests/sandbox/config.toml').read_text())
assert cfg['auth']['enable_signup'] is False and cfg['auth']['email']['enable_signup'] is True
assert cfg['storage']['enabled'] is True
assert not (root/'.env.local').exists()
print('Exact released application/migrations/dependencies, local Auth provider and Storage, Vercel disabled: PASS')
