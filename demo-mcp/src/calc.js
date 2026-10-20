// Safe arithmetic evaluator (recursive descent). We NEVER use eval()/new Function(): a "calculator" tool that evals model-supplied
// text is remote code execution for whoever can influence the prompt.   grammar: expr := term (('+'|'-') term)* ; term := factor (('*'|'/'|'%') factor)* ;
// factor := '-' factor | number | '(' expr ')'
export function calculate(input) {
  const s = String(input);
  if (s.length > 200) throw new Error('expression too long');
  let i = 0;
  const ws = () => { while (s[i] === ' ') i++; };
  const peek = () => { ws(); return s[i]; };
  function number() {
    ws(); const m = /^\d+(\.\d+)?/.exec(s.slice(i));
    if (!m) throw new Error(`unexpected "${s[i] ?? 'end of input'}" at position ${i}`);
    i += m[0].length; return Number(m[0]);
  }
  function factor(depth) {
    if (depth > 50) throw new Error('expression too deeply nested');
    const c = peek();
    if (c === '-') { i++; return -factor(depth + 1); }
    if (c === '(') { i++; const v = expr(depth + 1); if (peek() !== ')') throw new Error('missing )'); i++; return v; }
    return number();
  }
  function term(depth) {
    let v = factor(depth);
    for (let c = peek(); c === '*' || c === '/' || c === '%'; c = peek()) {
      i++; const r = factor(depth);
      if ((c === '/' || c === '%') && r === 0) throw new Error('division by zero');
      v = c === '*' ? v * r : c === '/' ? v / r : v % r;
    }
    return v;
  }
  function expr(depth) { let v = term(depth); for (let c = peek(); c === '+' || c === '-'; c = peek()) { i++; const r = term(depth); v = c === '+' ? v + r : v - r; } return v; }
  const result = expr(0);
  if (peek() !== undefined) throw new Error(`unexpected "${s[i]}" at position ${i}`);
  if (!Number.isFinite(result)) throw new Error('result is not a finite number');
  return result;
}
