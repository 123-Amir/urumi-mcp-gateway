#!/usr/bin/env python3
"""Mutation test for check_manifests.py: inject one fault at a time into a good render; the checker MUST fail with the expected message.
A checker that cannot fail proves nothing."""
import base64, copy, glob, os, shutil, subprocess, sys, tempfile
import yaml
HERE = os.path.dirname(os.path.abspath(__file__)); CHECK = os.path.join(HERE, 'check_manifests.py')

def load(d):
    out = {}
    for f in glob.glob(os.path.join(d, '*.yaml')): out[os.path.basename(f)] = [x for x in yaml.safe_load_all(open(f)) if x]
    return out
def save(docs, d):
    os.makedirs(d, exist_ok=True)
    for f, ds in docs.items(): yaml.safe_dump_all(ds, open(os.path.join(d, f), 'w'))
def find(docs, kind, suffix):
    for ds in docs.values():
        for x in ds:
            if x['kind'] == kind and x['metadata']['name'].endswith(suffix): return x
    raise KeyError((kind, suffix))
def cont(w, i=0): return w['spec']['template']['spec']['containers'][i]

def m_noresources(d): del cont(find(d, 'Deployment', '-gateway'))['resources']
def m_nolive(d): del cont(find(d, 'Deployment', '-dashboard'))['livenessProbe']
def m_noready(d): del cont(find(d, 'Deployment', '-gateway'))['readinessProbe']
def m_rooted(d): c = cont(find(d, 'Deployment', '-gateway')); c['securityContext']['allowPrivilegeEscalation'] = True
def m_nonroot(d): find(d, 'Deployment', '-gateway')['spec']['template']['spec']['securityContext'].pop('runAsNonRoot')
def m_latest(d): cont(find(d, 'Deployment', '-dashboard'))['image'] = 'nginx:latest'
def m_literal(d): cont(find(d, 'Deployment', '-woo-mcp'))['env'][-1] = {'name': 'MCP_AUTH_TOKEN', 'value': 'hardcoded'}
def m_badkey(d): cont(find(d, 'Deployment', '-woo-mcp'))['env'][-1]['valueFrom']['secretKeyRef']['key'] = 'NOPE'
def m_typo(d): cont(find(d, 'Deployment', '-woo-mcp'))['env'][1]['name'] = 'WC_BASEURL'
def m_selector(d): find(d, 'Service', '-gateway')['spec']['selector']['app.kubernetes.io/component'] = 'gatewey'
def m_nodeport(d): find(d, 'Service', '-woo-mcp')['spec']['type'] = 'NodePort'
def m_expose(d):
    ing = find(d, 'Ingress', '-gateway'); ing['spec']['rules'][0]['http']['paths'].append({'path': '/woo', 'pathType': 'Prefix', 'backend': {'service': {'name': 'urumi-woo-mcp', 'port': {'name': 'http'}}}})
def m_np_open(d): find(d, 'NetworkPolicy', '-woo-mcp')['spec']['ingress'][0]['from'][0]['podSelector']['matchLabels']['app.kubernetes.io/component'] = 'dashboard'
def m_no_default_deny(d):
    for ds in d.values():
        ds[:] = [x for x in ds if not (x['kind'] == 'NetworkPolicy' and x['metadata']['name'].endswith('default-deny'))]
def m_egress_all(d): find(d, 'NetworkPolicy', '-gateway')['spec']['egress'][1]['to'][0]['ipBlock']['except'] = []
def m_leak(d):
    sec = find(d, 'Secret', '-secrets'); val = base64.b64decode(sec['data']['MARIADB_ROOT_PASSWORD']).decode()
    find(d, 'ConfigMap', '-wp-setup')['data']['oops.txt'] = f'password={val}'
def m_origin(d):
    for e in cont(find(d, 'Deployment', '-gateway'))['env']:
        if e['name'] == 'PUBLIC_ORIGINS': e['value'] = 'http://evil.example'
def m_prod_insecure(d):   # NODE_ENV=production while cookies are not Secure: the REAL gateway config loader must refuse
    for e in cont(find(d, 'Deployment', '-gateway'))['env']:
        if e['name'] == 'NODE_ENV': e['value'] = 'production'
def m_allowlist(d):
    for e in cont(find(d, 'Deployment', '-gateway'))['env']:
        if e['name'] == 'UPSTREAM_ALLOWED_HOSTS': e['value'] = 'something-else.local'
def m_encKey(d): find(d, 'Secret', '-secrets')['data']['GATEWAY_ENCRYPTION_KEY'] = base64.b64encode(base64.b64encode(b'short')).decode()
def m_port(d): cont(find(d, 'Deployment', '-dashboard'))['readinessProbe']['httpGet']['port'] = 'nope'
def m_mount(d): cont(find(d, 'Deployment', '-gateway'))['volumeMounts'].append({'name': 'ghost', 'mountPath': '/ghost'})

CASES = [(m_noresources, r'requests\+limits'), (m_nolive, 'livenessProbe required'), (m_noready, 'readinessProbe required'), (m_rooted, 'allowPrivilegeEscalation'),
    (m_nonroot, 'non-root'), (m_latest, 'pinned tag'), (m_literal, 'must come from a Secret'), (m_badkey, 'referenced keys missing|unknown secret keys'), (m_typo, 'never reads'),
    (m_selector, 'selector matches no pod'), (m_nodeport, 'only ClusterIP'), (m_expose, 'must not be exposed'), (m_np_open, 'ONLY from gateway'),
    (m_no_default_deny, 'default-deny'), (m_egress_all, 'exclude private ranges'), (m_leak, 'leaked into a non-Secret'), (m_origin, 'PUBLIC_ORIGINS'),
    (m_prod_insecure, 'REAL gateway config loader'), (m_allowlist, 'SSRF allowlist'), (m_encKey, '32 bytes'), (m_port, 'undefined port name'), (m_mount, 'has no volume')]

if __name__ == '__main__':
    good = sys.argv[1]; bad = 0
    base = subprocess.run([sys.executable, CHECK, good], capture_output=True, text=True); assert base.returncode == 0, 'baseline render must pass first:\n' + base.stdout
    for fn, expect in CASES:
        docs = copy.deepcopy(load(good)); tmp = tempfile.mkdtemp(); fn(docs); save(docs, tmp)
        r = subprocess.run([sys.executable, CHECK, tmp], capture_output=True, text=True); shutil.rmtree(tmp)
        import re
        caught = r.returncode != 0 and re.search(expect, r.stdout) is not None
        print(('CAUGHT ' if caught else 'MISSED ') + f'{fn.__name__:20s} expected /{expect}/' + ('' if caught else f'  (rc={r.returncode})')); bad += not caught
    print(f'\n{len(CASES) - bad}/{len(CASES)} injected faults detected'); sys.exit(1 if bad else 0)
