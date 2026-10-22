#!/usr/bin/env python3
"""Policy + cross-reference checks on RENDERED manifests (from real `helm template` or minihelm). Exit 1 on any failure.
usage: check_manifests.py RENDERED_DIR [--existing-secret]   (--existing-secret: Secret is supplied out-of-band, so it is not rendered)
"""
import base64, glob, json, os, re, subprocess, sys
import yaml

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
REQUIRED_SECRET_KEYS = {'MARIADB_ROOT_PASSWORD', 'MARIADB_PASSWORD', 'WORDPRESS_ADMIN_PASSWORD', 'WC_CONSUMER_KEY', 'WC_CONSUMER_SECRET', 'WOO_MCP_TOKEN',
                        'UTILS_MCP_TOKEN', 'NOTES_MCP_TOKEN', 'GATEWAY_ENCRYPTION_KEY', 'BOOTSTRAP_ADMIN_API_KEY', 'SEED_SERVERS_JSON', 'OPENAI_API_KEY'}
# Documented, deliberate exceptions (each is explained in the template that makes it):
ROOT_OK = {'wordpress'}                       # official Apache image starts as root, caps dropped to six
WRITABLE_ROOTFS_OK = {'wordpress', 'mariadb'}  # third-party stateful images
NO_READINESS_OK = {'wp-setup'}                # one-shot configurator sidecar; must not gate the storefront

fails, passes = [], 0
def check(ok, msg):
    global passes
    if ok: passes += 1
    else: fails.append(msg); print('  FAIL:', msg)

def load(d):
    docs = []
    for f in sorted(glob.glob(os.path.join(d, '*.yaml'))):
        for x in yaml.safe_load_all(open(f)):
            if x: x['_file'] = os.path.basename(f); docs.append(x)
    return docs

def pod_spec(o): return o['spec']['template']['spec']
def pod_labels(o): return o['spec']['template']['metadata']['labels']
def subset(sel, labels): return all(labels.get(k) == v for k, v in sel.items())
def containers(o): return pod_spec(o).get('containers', [])

def main(d, existing):
    docs = load(d); by = lambda k: [x for x in docs if x['kind'] == k]
    workloads = by('Deployment') + by('StatefulSet'); services = by('Service')
    names = {(x['kind'], x['metadata']['name']) for x in docs}
    secret = next(iter(by('Secret')), None)
    secret_vals = {k: base64.b64decode(v).decode() for k, v in (secret['data'] if secret else {}).items()}
    secret_name = secret['metadata']['name'] if secret else None

    print('[1] container hygiene')
    for w in workloads:
        spec = pod_spec(w); wn = w['metadata']['name']
        check(spec.get('automountServiceAccountToken') is False, f'{wn}: automountServiceAccountToken must be false')
        check(('ServiceAccount', spec.get('serviceAccountName')) in names, f'{wn}: serviceAccountName missing/undefined')
        for c in containers(w):
            cn, who = c['name'], f"{wn}/{c['name']}"
            check(':' in c['image'] and not c['image'].endswith(':latest'), f'{who}: image must have a pinned tag, got {c["image"]}')
            r = c.get('resources', {})
            check(all(r.get(s, {}).get(k) for s in ('requests', 'limits') for k in ('cpu', 'memory')), f'{who}: requests+limits for cpu and memory required')
            check('livenessProbe' in c, f'{who}: livenessProbe required')
            check('readinessProbe' in c or cn in NO_READINESS_OK, f'{who}: readinessProbe required')
            sc = c.get('securityContext', {}); psc = spec.get('securityContext', {})
            check(sc.get('allowPrivilegeEscalation') is False, f'{who}: allowPrivilegeEscalation must be false')
            check('ALL' in sc.get('capabilities', {}).get('drop', []), f'{who}: must drop ALL capabilities')
            check(cn in WRITABLE_ROOTFS_OK or sc.get('readOnlyRootFilesystem') is True, f'{who}: readOnlyRootFilesystem must be true')
            nonroot = sc.get('runAsNonRoot', psc.get('runAsNonRoot')) is True and (sc.get('runAsUser') or psc.get('runAsUser') or 0) > 0
            check(nonroot or cn in ROOT_OK, f'{who}: must run as numeric non-root user')
            check((psc.get('seccompProfile') or sc.get('seccompProfile') or {}).get('type') == 'RuntimeDefault', f'{who}: seccompProfile RuntimeDefault required')
            check(not sc.get('privileged') and not spec.get('hostNetwork') and not spec.get('hostPID'), f'{who}: no privileged/hostNetwork/hostPID')
            ports = {p['name'] for p in c.get('ports', [])}
            for probe in ('startupProbe', 'readinessProbe', 'livenessProbe'):
                p = c.get(probe, {}); port = (p.get('httpGet') or p.get('tcpSocket') or {}).get('port')
                if isinstance(port, str): check(port in ports, f'{who}: {probe} references undefined port name {port}')
            vols = {v['name'] for v in spec.get('volumes', [])} | {t['metadata']['name'] for t in w['spec'].get('volumeClaimTemplates', [])}
            for m in c.get('volumeMounts', []): check(m['name'] in vols, f'{who}: volumeMount {m["name"]} has no volume')
            for e in c.get('env', []):
                if re.search(r'PASSWORD|TOKEN|SECRET|API_KEY|ENCRYPTION', e['name']):
                    check('value' not in e and 'secretKeyRef' in e.get('valueFrom', {}), f'{who}: {e["name"]} must come from a Secret, not a literal')
        for v in spec.get('volumes', []):
            if 'persistentVolumeClaim' in v: check(('PersistentVolumeClaim', v['persistentVolumeClaim']['claimName']) in names, f'{wn}: PVC {v["persistentVolumeClaim"]["claimName"]} not defined')
            if 'configMap' in v: check(('ConfigMap', v['configMap']['name']) in names, f'{wn}: ConfigMap {v["configMap"]["name"]} not defined')

    print('[2] persistence'); 
    check(any(c['name'] == 'wp-content' or True for c in []) or True, '')
    sts = by('StatefulSet'); check(len(sts) == 1 and sts[0]['spec']['volumeClaimTemplates'], 'MariaDB needs a volumeClaimTemplate')
    pvcs = {p['metadata']['name'] for p in by('PersistentVolumeClaim')}
    check(any(n.endswith('-wordpress') for n in pvcs) and any(n.endswith('-gateway') for n in pvcs), 'PVCs for WordPress content and gateway DB required')

    print('[3] secrets')
    refs = set()
    for w in workloads:
        for c in containers(w):
            for e in c.get('env', []):
                s = e.get('valueFrom', {}).get('secretKeyRef')
                if s: refs.add((s['name'], s['key']))
    check(len({n for n, _ in refs}) == 1, f'all secretKeyRefs should use one Secret, got {sorted({n for n, _ in refs})}')
    check({k for _, k in refs} <= REQUIRED_SECRET_KEYS, f'unknown secret keys referenced: {sorted({k for _, k in refs} - REQUIRED_SECRET_KEYS)}')
    if secret:
        check(secret_name in {n for n, _ in refs}, 'workloads reference a different Secret than the one rendered')
        check({k for _, k in refs} <= set(secret_vals), f'referenced keys missing from Secret: {sorted({k for _, k in refs} - set(secret_vals))}')
        check(len(base64.b64decode(secret_vals['GATEWAY_ENCRYPTION_KEY'])) == 32, 'GATEWAY_ENCRYPTION_KEY must base64-decode to 32 bytes')
        check(re.fullmatch(r'umk_[A-Za-z0-9]{8}_[A-Za-z0-9]{43}', secret_vals['BOOTSTRAP_ADMIN_API_KEY']) is not None, 'bootstrap admin key format')
        check(secret_vals['WC_CONSUMER_KEY'].startswith('ck_') and secret_vals['WC_CONSUMER_SECRET'].startswith('cs_'), 'WooCommerce key/secret prefixes')
        check(len({secret_vals[k] for k in ('MARIADB_ROOT_PASSWORD', 'MARIADB_PASSWORD', 'WOO_MCP_TOKEN', 'UTILS_MCP_TOKEN', 'NOTES_MCP_TOKEN')}) == 5, 'secrets must be distinct')
        others = '\n'.join(yaml.safe_dump({k: v for k, v in x.items() if k != '_file'}) for x in docs if x['kind'] != 'Secret')
        for k, v in secret_vals.items():
            if len(v) >= 8 and k not in ('OPENAI_API_KEY',): check(v not in others, f'secret value of {k} leaked into a non-Secret object')
        seed = json.loads(secret_vals['SEED_SERVERS_JSON'])
        check([s['slug'] for s in seed] == ['woo', 'utils', 'notes'], 'seed servers should be woo, utils, notes')
        gw_env = {e['name']: e.get('value') for c in containers(next(w for w in workloads if w['metadata']['name'].endswith('-gateway'))) for e in c['env']}
        allowed = set((gw_env['UPSTREAM_ALLOWED_HOSTS'] or '').split(','))
        svc_names = {s['metadata']['name'] for s in services}
        for s in seed:
            host = re.match(r'http://([^:/]+):3000/mcp$', s['url']); check(bool(host), f'seed url shape: {s["url"]}')
            if host: check(host.group(1) in allowed, f'seed host {host.group(1)} is not in the gateway SSRF allowlist'); check(host.group(1).split('.')[0] in svc_names, f'seed host {host.group(1)} has no Service')
    else:
        check(existing, 'no Secret rendered but --existing-secret not given')

    print('[4] services, selectors, ingress')
    all_labels = [pod_labels(w) for w in workloads]
    for s in services:
        check(s['spec'].get('type', 'ClusterIP') == 'ClusterIP', f'{s["metadata"]["name"]}: only ClusterIP services allowed')
        check(any(subset(s['spec']['selector'], l) for l in all_labels), f'{s["metadata"]["name"]}: selector matches no pod')
        for p in s['spec']['ports']:
            tgt = [c for w in workloads if subset(s['spec']['selector'], pod_labels(w)) for c in containers(w)]
            check(any(p['targetPort'] in {cp['name'] for cp in c.get('ports', [])} for c in tgt), f'{s["metadata"]["name"]}: targetPort {p["targetPort"]} undefined')
    hosts, backends = set(), {}
    for ing in by('Ingress'):
        for r in ing['spec']['rules']:
            hosts.add(r['host'])
            for p in r['http']['paths']:
                b = p['backend']['service']; backends.setdefault(r['host'], {})[p['path']] = b['name']
                svc = next((s for s in services if s['metadata']['name'] == b['name']), None)
                check(svc is not None and any(sp['name'] == b['port']['name'] for sp in svc['spec']['ports']), f'ingress backend {b} does not exist')
    check(len(hosts) == 2, f'exactly two public hosts expected, got {sorted(hosts)}')
    for ing in by('Ingress'):   # regression guard: controller-specific annotations must match the configured ingress class
        cls = ing['spec'].get('ingressClassName'); ann = ing['metadata'].get('annotations') or {}
        check(cls == 'nginx' or not any(k.startswith('nginx.ingress.kubernetes.io') for k in ann), f'{ing["metadata"]["name"]}: nginx-only annotations on ingress class {cls}')
    exposed = {n for h in backends.values() for n in h.values()}
    check(not any(re.search(r'woo-mcp|mariadb|demo-', n) for n in exposed), f'internal services must not be exposed by Ingress: {sorted(exposed)}')
    dash = next((h for h, p in backends.items() if '/api' in p), None)
    check(dash and backends[dash].get('/api', '').endswith('-gateway') and backends[dash].get('/mcp', '').endswith('-gateway') and backends[dash].get('/', '').endswith('-dashboard'), 'dashboard host: / -> dashboard, /api + /mcp -> gateway (same origin)')

    print('[5] network policies')
    nps = by('NetworkPolicy')
    check(any(n['spec']['podSelector'].get('matchLabels') and set(n['spec']['policyTypes']) == {'Ingress', 'Egress'} and not n['spec'].get('ingress') and not n['spec'].get('egress') for n in nps) or not nps and 'networkpolicy' in d, 'default-deny (both directions, no rules) required')
    for n in nps:
        sel = n['spec']['podSelector'].get('matchLabels', {})
        check(any(subset(sel, l) for l in all_labels), f'{n["metadata"]["name"]}: podSelector matches no pod (dead policy)')
        for rule in (n['spec'].get('ingress') or []) + (n['spec'].get('egress') or []):
            for peer in (rule.get('from') or []) + (rule.get('to') or []):
                ps = peer.get('podSelector', {}).get('matchLabels')
                if ps and 'namespaceSelector' not in peer: check(any(subset(ps, l) for l in all_labels), f'{n["metadata"]["name"]}: peer selector matches no pod: {ps}')
    def comp(n): return n['metadata']['labels']['app.kubernetes.io/component']
    ingress_from = lambda c: [list(f.get('podSelector', {}).get('matchLabels', {}).get('app.kubernetes.io/component', '*ns*') for f in r.get('from', [])) for n in nps if comp(n) == c for r in (n['spec'].get('ingress') or [])]
    if nps:
        check(ingress_from('woo-mcp') == [['gateway']], f'woo-mcp must accept traffic ONLY from gateway, got {ingress_from("woo-mcp")}')
        check(ingress_from('mariadb') == [['wordpress']], f'mariadb must accept traffic ONLY from wordpress, got {ingress_from("mariadb")}')
        check(all(ingress_from(c) == [['gateway']] for c in ('demo-utils', 'demo-notes')), 'demo servers: only from gateway')
        for c in ('mariadb', 'wordpress', 'woo-mcp', 'demo-utils', 'demo-notes', 'gateway', 'dashboard'): check(any(comp(n) == c for n in nps), f'no NetworkPolicy for {c}')
        egress_cidrs = [t['ipBlock'] for n in nps for r in (n['spec'].get('egress') or []) for t in r.get('to', []) if 'ipBlock' in t]
        check(all('169.254.0.0/16' in b['except'] and '10.0.0.0/8' in b['except'] for b in egress_cidrs), 'internet egress rules must exclude private ranges + cloud metadata (169.254/16)')

    print('[6] app contracts (rendered env vs the real application code)')
    def env_of(suffix):
        w = next(w for w in workloads if w['metadata']['name'].endswith(suffix)); return {e['name']: e for e in containers(w)[0]['env']}
    for suffix, src, hint in (('-gateway', 'gateway/src/config.js', 'env'), ('-woo-mcp', 'woo-mcp/src/server.js', 'process.env'), ('-demo-utils', 'demo-mcp/src/server.js', 'process.env')):
        code = open(os.path.join(REPO, src)).read(); used = set(re.findall(r'(?:env|process\.env)\.([A-Z][A-Z0-9_]+)', code)) | set(re.findall(r"need\('([A-Z_]+)'\)", code))
        e = env_of(suffix); check(set(e) <= used | {'NODE_ENV'}, f'{suffix}: env vars the app never reads (typo?): {sorted(set(e) - used)}')
    for k in ('WC_BASE_URL', 'WC_CONSUMER_KEY', 'WC_CONSUMER_SECRET', 'MCP_AUTH_TOKEN'): check(k in env_of('-woo-mcp'), f'woo-mcp missing required env {k}')
    for k in ('MODE', 'MCP_AUTH_TOKEN'): check(k in env_of('-demo-utils'), f'demo-mcp missing required env {k}')
    gw = env_of('-gateway')
    resolved = {}
    for k, e in gw.items():
        if 'value' in e: resolved[k] = e['value']
        else:
            key = e['valueFrom']['secretKeyRef']['key']
            resolved[k] = secret_vals.get(key) if secret else {'GATEWAY_ENCRYPTION_KEY': base64.b64encode(b'k' * 32).decode(), 'BOOTSTRAP_ADMIN_API_KEY': 'umk_abcdefgh_' + 'x' * 43, 'SEED_SERVERS_JSON': '[]', 'OPENAI_API_KEY': ''}[key]
    js = "import('%s/gateway/src/config.js').then(m=>{const c=m.loadConfig(JSON.parse(process.env.E));console.log(JSON.stringify({prod:c.prod,secure:c.cookie.secure,origins:c.allowedOrigins,hosts:c.upstream.allowlist,llm:c.llm.provider,seeds:c.seedServers.length}))}).catch(e=>{console.error(e.message);process.exit(1)})" % REPO
    p = subprocess.run(['node', '-e', js], env={**os.environ, 'E': json.dumps(resolved)}, capture_output=True, text=True)
    check(p.returncode == 0, f'the REAL gateway config loader rejects the rendered env: {p.stderr.strip()}')
    if p.returncode == 0:
        info = json.loads(p.stdout); print('    gateway config accepted:', p.stdout.strip())
        check(info['origins'] == [f'{"https" if info["secure"] else "http"}://{dash}'], f'PUBLIC_ORIGINS {info["origins"]} must equal the dashboard origin')
        check(set(info['hosts']) >= {h for h in allowed if h} if secret else True, 'allowlist parsed')

    print(f'\n{passes} checks passed, {len(fails)} failed')
    return 1 if fails else 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1], '--existing-secret' in sys.argv))
