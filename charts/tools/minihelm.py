#!/usr/bin/env python3
"""minihelm: a deliberately SMALL Go-template/Helm-subset renderer used only to *check* this chart where the real `helm` binary is
unavailable. It is NOT Helm and proves nothing about Helm itself; `scripts/verify-chart.sh` runs the real `helm lint/template`
whenever `helm` is installed. It implements only what charts/urumi uses and is strict: a nil value being printed (Helm's "<no value>")
is an error, and unknown functions fail loudly instead of being ignored.

usage: minihelm.py CHART_DIR OUT_DIR [-f values.yaml]... [--set a.b=c]... [--name release] [--namespace ns]
"""
import base64, hashlib, json, os, random, re, string, sys
import yaml


class TemplateError(Exception):
    pass


# ----------------------------------------------------------------------------- lexing
ACTION = re.compile(r'\{\{(-?)\s*(.*?)\s*(-?)\}\}', re.S)


def lex(src, fname):
    """-> list of ('text', str) | ('action', str). Applies {{- and -}} trim markers; drops comments."""
    out, pos = [], 0
    for m in re.finditer(r'\{\{(-[ \t\r\n])?(.*?)([ \t\r\n]-)?\}\}', src, re.S):
        text = src[pos:m.start()]
        if m.group(1): text = text.rstrip(' \t\r\n')
        out.append(['text', text])
        body = m.group(2).strip()
        if not body.startswith('/*'): out.append(['action', body])
        pos = m.end()
        if m.group(3):  # right trim applies to the NEXT text chunk
            rest = src[pos:]; stripped = rest.lstrip(' \t\r\n'); pos += len(rest) - len(stripped)
    out.append(['text', src[pos:]])
    return out


# ----------------------------------------------------------------------------- expression tokens
TOK = re.compile(r'''\s*(?:
  (?P<str>"(?:[^"\\]|\\.)*") | (?P<raw>`[^`]*`) |
  (?P<num>-?\d+(?:\.\d+)?)(?![\w.]) |
  (?P<var>\$(?:[A-Za-z_]\w*)?(?:\.[A-Za-z_]\w*)*) |
  (?P<field>\.(?:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?) |
  (?P<id>[A-Za-z_]\w*) | (?P<op>:=|[()|=,])
)''', re.X)


def tokens(s):
    out, pos = [], 0
    while pos < len(s):
        m = TOK.match(s, pos)
        if not m or m.end() == pos:
            if s[pos:].strip() == '': break
            raise TemplateError(f'cannot tokenize near: {s[pos:pos+40]!r}')
        pos = m.end()
        k = m.lastgroup; out.append((k, m.group(k)))
    return out


# ----------------------------------------------------------------------------- parsing to AST
def parse(chunks, fname):
    """Returns (nodes, defines). Node: ('text',s) ('act',expr) ('if',cond,then,else) ('range',vars,expr,body,else) ('with',expr,body,else)"""
    defines = {}; i = 0

    def block(stop):
        nonlocal i
        nodes = []
        while i < len(chunks):
            kind, val = chunks[i]
            if kind == 'text':
                if val: nodes.append(('text', val))
                i += 1; continue
            head = val.split(None, 1)[0] if val else ''
            rest = val[len(head):].strip()
            if head in stop: return nodes, head, rest
            i += 1
            if head == 'define':
                name = tokens(rest)[0][1][1:-1]
                body, end, _ = block({'end'}); i += 1; defines[name] = body
            elif head == 'if':
                nodes.append(parse_if(rest))
            elif head == 'range':
                m = re.match(r'(?:(\$\w+)\s*,\s*)?(\$\w+)\s*:=\s*(.*)', rest, re.S)
                vars_, expr = ((m.group(1), m.group(2)), m.group(3)) if m else ((None, None), rest)
                body, end, _ = block({'else', 'end'}); els = []
                if end == 'else': i += 1; els, end, _ = block({'end'})
                i += 1; nodes.append(('range', vars_, expr, body, els))
            elif head == 'with':
                body, end, _ = block({'else', 'end'}); els = []
                if end == 'else': i += 1; els, end, _ = block({'end'})
                i += 1; nodes.append(('with', rest, body, els))
            elif head in ('end', 'else'):
                raise TemplateError(f'{fname}: unexpected {{{{ {head} }}}}')
            else:
                nodes.append(('act', val))
        if stop: raise TemplateError(f'{fname}: missing {{{{ end }}}}')
        return nodes, None, None

    def parse_if(cond):
        nonlocal i
        body, end, rest = block({'else', 'end'}); els = []
        if end == 'else':
            i += 1
            if rest.startswith('if '):   # {{ else if X }}
                els = [parse_if(rest[3:].strip())]; return ('if', cond, body, els)
            els, end, _ = block({'end'})
        i += 1
        return ('if', cond, body, els)

    nodes, _, _ = block(set())
    return nodes, defines


# ----------------------------------------------------------------------------- values / truthiness / formatting
def truthy(v):
    return not (v is None or v is False or v == 0 and not isinstance(v, str) or v == '' or v == [] or v == {})


def fmt(v):
    if v is None: raise TemplateError('<no value>: a nil value was printed (missing key?)')
    if isinstance(v, bool): return 'true' if v else 'false'
    if isinstance(v, (dict, list)): raise TemplateError(f'cannot print a {type(v).__name__} directly: {str(v)[:60]}')
    if isinstance(v, float) and v == int(v): return str(int(v))
    return str(v)


def indent_text(n, s): return '\n'.join((' ' * n + l) if l else l for l in str(s).split('\n'))


def go_printf(f, *a):
    a = list(a); out = ''
    def sub(m):
        spec = m.group(0)
        if spec == '%%': return '%'
        v = a.pop(0)
        if spec == '%d': return str(int(v))
        return fmt(v)
    return re.sub(r'%%|%[sdv]', sub, f)


class Chart:
    def __init__(self, name, version, base):
        self.Name, self.Version, self.base = name, version, base


class Renderer:
    def __init__(self, chart_dir, values, release, namespace):
        self.dir = chart_dir; self.defines = {}; self.files = {}
        meta = yaml.safe_load(open(os.path.join(chart_dir, 'Chart.yaml')))
        self.root = {'Values': values, 'Chart': {'Name': meta['name'], 'Version': str(meta['version']), 'AppVersion': str(meta.get('appVersion', ''))},
                     'Release': {'Name': release, 'Namespace': namespace, 'Service': 'Helm', 'IsInstall': True},
                     'Template': {'BasePath': f"{meta['name']}/templates"}}
        tdir = os.path.join(chart_dir, 'templates')
        for f in sorted(os.listdir(tdir)):
            if f.endswith(('.yaml', '.tpl', '.txt')):
                src = open(os.path.join(tdir, f)).read()
                nodes, defs = parse(lex(src, f), f); self.defines.update(defs)
                if not f.startswith('_'): self.files[f'{meta["name"]}/templates/{f}'] = nodes
        self.funcs = self.build_funcs()

    # ---- functions (Helm/sprig subset)
    def build_funcs(self):
        r = self
        def include(name, ctx):
            if name not in r.defines and name not in r.files: raise TemplateError(f'include: unknown template {name!r}')
            nodes = r.defines.get(name) or r.files[name]
            return r.render_nodes(nodes, ctx, Env(None, {'$': ctx}), name)
        def to_yaml(v):
            if v in (None, {}, []): return '{}' if isinstance(v, dict) else ('[]' if isinstance(v, list) else 'null')
            return yaml.safe_dump(v, default_flow_style=False, sort_keys=True).rstrip('\n')
        def required(msg, v):
            if not truthy(v): raise TemplateError(f'required: {msg}')
            return v
        def fail(msg): raise TemplateError(f'fail: {msg}')
        def default(d, v=None): return v if truthy(v) else d
        def quote(*a): return ' '.join('"' + fmt(x).replace('\\', '\\\\').replace('"', '\\"') + '"' for x in a if x is not None)
        def dict_(*a):
            if len(a) % 2: raise TemplateError('dict: odd number of arguments')
            return {a[i]: a[i + 1] for i in range(0, len(a), 2)}
        def and_(*a):
            for x in a:
                if not truthy(x): return x
            return a[-1]
        def or_(*a):
            for x in a:
                if truthy(x): return x
            return a[-1]
        return {
            'include': include, 'default': default, 'quote': quote, 'toYaml': to_yaml, 'required': required, 'fail': fail,
            'nindent': lambda n, s: '\n' + indent_text(int(n), s), 'indent': lambda n, s: indent_text(int(n), s),
            'b64enc': lambda s: base64.b64encode(str(s).encode()).decode(), 'b64dec': lambda s: base64.b64decode(str(s)).decode(),
            'dict': dict_, 'list': lambda *a: list(a), 'append': lambda l, x: list(l) + [x], 'join': lambda sep, l: sep.join(fmt(x) for x in l),
            'printf': go_printf, 'print': lambda *a: ''.join(fmt(x) for x in a), 'trunc': lambda n, s: str(s)[:int(n)],
            'trimSuffix': lambda suf, s: str(s)[:-len(suf)] if suf and str(s).endswith(suf) else str(s),
            'lower': lambda s: str(s).lower(), 'upper': lambda s: str(s).upper(), 'int': lambda v: int(v), 'toString': fmt,
            'toJson': lambda v: json.dumps(v, separators=(',', ':'), sort_keys=True, ensure_ascii=False),
            'eq': lambda a, *b: any(a == x for x in b), 'ne': lambda a, b: a != b, 'and': and_, 'or': or_, 'not': lambda v: not truthy(v),
            'get': lambda d, k: (d or {}).get(k, ''), 'hasKey': lambda d, k: k in (d or {}), 'len': lambda v: len(v),
            'lookup': lambda *a: {},   # `helm template` has no cluster: lookup returns an empty map, exactly like Helm does
            'randAlphaNum': lambda n: ''.join(random.choice(string.ascii_letters + string.digits) for _ in range(int(n))),
            'sha256sum': lambda s: hashlib.sha256(str(s).encode()).hexdigest(),
        }

    # ---- evaluation
    def value(self, tok, dot, env):
        k, v = tok
        if k == 'str': return json.loads(v)
        if k == 'raw': return v[1:-1]
        if k == 'num': return float(v) if '.' in v else int(v)
        if k == 'id':
            if v in ('true', 'false'): return v == 'true'
            if v == 'nil': return None
            raise TemplateError(f'unexpected identifier {v!r}')
        if k == 'var':
            parts = v.split('.'); name = parts[0]
            cur = env.get(name)
            for p in parts[1:]: cur = self.field(cur, p)
            return cur
        if k == 'field':
            if v == '.': return dot
            cur = dot
            for p in v[1:].split('.'): cur = self.field(cur, p)
            return cur
        raise TemplateError(f'bad value token {tok}')

    @staticmethod
    def field(cur, name):
        if isinstance(cur, dict): return cur.get(name)
        if cur is None: raise TemplateError(f'nil pointer evaluating .{name}')
        raise TemplateError(f'cannot read .{name} of {type(cur).__name__}')

    def eval_pipeline(self, toks, dot, env):
        # split on top-level '|'
        cmds, cur, depth = [], [], 0
        for t in toks:
            if t == ('op', '('): depth += 1
            if t == ('op', ')'): depth -= 1
            if t == ('op', '|') and depth == 0: cmds.append(cur); cur = []
            else: cur.append(t)
        cmds.append(cur)
        val, first = None, True
        for cmd in cmds:
            val = self.eval_command(cmd, dot, env, None if first else (val,)); first = False
        return val

    def eval_command(self, cmd, dot, env, piped):
        args, i = [], 0
        while i < len(cmd):
            t = cmd[i]
            if t == ('op', '('):
                depth, j = 1, i + 1
                while depth:
                    if cmd[j] == ('op', '('): depth += 1
                    if cmd[j] == ('op', ')'): depth -= 1
                    j += 1
                args.append(('val', self.eval_pipeline(cmd[i + 1:j - 1], dot, env))); i = j
            else:
                args.append(('tok', t)); i += 1
        head = args[0]
        if head[0] == 'tok' and head[1][0] == 'id' and head[1][1] not in ('true', 'false', 'nil'):
            fname = head[1][1]
            if fname not in self.funcs: raise TemplateError(f'unsupported function {fname!r} (add it to minihelm only if real Helm has it)')
            ev = [a[1] if a[0] == 'val' else self.value(a[1], dot, env) for a in args[1:]]
            if piped is not None: ev.append(piped[0])
            return self.funcs[fname](*ev)
        if len(args) > 1 or piped is not None: raise TemplateError(f'cannot call non-function: {cmd}')
        return head[1] if head[0] == 'val' else self.value(head[1], dot, env)

    def eval_expr(self, expr, dot, env):
        toks = tokens(expr)
        # assignment:  $x := pipeline   |   $x = pipeline
        if len(toks) > 2 and toks[0][0] == 'var' and toks[1] in (('op', ':='), ('op', '=')):
            v = self.eval_pipeline(toks[2:], dot, env)
            (env.declare if toks[1][1] == ':=' else env.assign)(toks[0][1], v)
            return ASSIGNED
        return self.eval_pipeline(toks, dot, env)

    def render_nodes(self, nodes, dot, env, name):
        out = []
        for n in nodes:
            try:
                if n[0] == 'text': out.append(n[1])
                elif n[0] == 'act':
                    v = self.eval_expr(n[1], dot, env)
                    if v is not ASSIGNED: out.append(fmt(v))
                elif n[0] == 'if':
                    c = self.eval_expr(n[1], dot, env)
                    out.append(self.render_nodes(n[2] if truthy(c) else n[3], dot, Env(env, {}), name))
                elif n[0] == 'with':
                    c = self.eval_expr(n[1], dot, env)
                    out.append(self.render_nodes(n[2], c, Env(env, {}), name) if truthy(c) else self.render_nodes(n[3], dot, Env(env, {}), name))
                elif n[0] == 'range':
                    (kv, vv), expr, body, els = n[1], n[2], n[3], n[4]
                    coll = self.eval_expr(expr, dot, env)
                    items = list(enumerate(coll)) if isinstance(coll, list) else sorted((coll or {}).items())
                    if not items: out.append(self.render_nodes(els, dot, Env(env, {}), name))
                    for k, v in items:
                        e = Env(env, {}); 
                        if vv: e.declare(vv, v)
                        if kv: e.declare(kv, k)
                        out.append(self.render_nodes(body, v if not vv else dot, e, name))
            except TemplateError as ex:
                raise TemplateError(f'{name}: {ex}\n    while evaluating: {{{{ {n[1] if isinstance(n[1], str) else n[0]} }}}}') from None
        return ''.join(out)


ASSIGNED = object()


class Env:
    def __init__(self, parent, vars_): self.parent, self.vars = parent, dict(vars_)
    def get(self, name):
        e = self
        while e:
            if name in e.vars: return e.vars[name]
            e = e.parent
        raise TemplateError(f'undefined variable {name}')
    def declare(self, name, v): self.vars[name] = v
    def assign(self, name, v):
        e = self
        while e:
            if name in e.vars: e.vars[name] = v; return
            e = e.parent
        raise TemplateError(f'assignment to undeclared variable {name}')


def deep_merge(a, b):
    for k, v in b.items():
        a[k] = deep_merge(a[k], v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
    return a


def set_path(d, path, raw):
    keys = path.split('.'); cur = d
    for k in keys[:-1]: cur = cur.setdefault(k, {})
    cur[keys[-1]] = yaml.safe_load(raw)


def render_chart(chart_dir, value_files=(), sets=(), release='urumi', namespace='urumi'):
    values = yaml.safe_load(open(os.path.join(chart_dir, 'values.yaml'))) or {}
    for f in value_files: deep_merge(values, yaml.safe_load(open(f)) or {})
    for s in sets:
        k, _, v = s.partition('='); set_path(values, k, v)
    r = Renderer(chart_dir, values, release, namespace)
    out = {}
    for name, nodes in r.files.items():
        out[name.split('/')[-1]] = r.render_nodes(nodes, r.root, Env(None, {'$': r.root}), name)
    return out, r.root


if __name__ == '__main__':
    a = sys.argv[1:]
    chart, outdir = a[0], a[1]; vf, sets, release, ns = [], [], 'urumi', 'urumi'; i = 2
    while i < len(a):
        if a[i] == '-f': vf.append(a[i + 1]); i += 2
        elif a[i] == '--set': sets.append(a[i + 1]); i += 2
        elif a[i] == '--name': release = a[i + 1]; i += 2
        elif a[i] == '--namespace': ns = a[i + 1]; i += 2
        else: sys.exit(f'unknown arg {a[i]}')
    try: rendered, _ = render_chart(chart, vf, sets, release, ns)
    except TemplateError as e: sys.exit(f'RENDER ERROR: {e}')
    os.makedirs(outdir, exist_ok=True)
    for f, txt in rendered.items(): open(os.path.join(outdir, f), 'w').write(txt)
    print(f'rendered {len(rendered)} files -> {outdir}')
