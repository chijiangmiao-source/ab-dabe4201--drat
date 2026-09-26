// 受限 DIMACS CNF 与顺序 DRAT 记录解析器。
// 设计要点：
//  - 变量必须是正整数（文字可带负号）；子句/记录必须以 0 结束；
//  - 同一条目内的重复文字、互补文字、越界变量、截断记录全部收集，
//    由调用方“合并定位”，而不是遇到第一个错误就丢弃其余诊断；
//  - 每个记号都带 1 基行/列位置，便于审查员核对供应商原件。

const INT_RE = /^-?[0-9]+$/;

/** 将文本切分为带行/列位置的记号行。 */
export function tokenize(text) {
  const rawLines = String(text ?? '').split(/\r?\n/);
  return rawLines.map((lineText, i) => {
    const tokens = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(lineText)) !== null) {
      tokens.push({ text: m[0], line: i + 1, col: m.index + 1 });
    }
    return { no: i + 1, text: lineText, tokens };
  });
}

function parseLiteralToken(tok, nvars, errors, scope) {
  if (!INT_RE.test(tok.text) || tok.text === '-0') {
    errors.push({
      scope,
      code: 'BAD_INTEGER',
      message: `记号 “${tok.text}” 不是合法整数文字（变量须为正整数，文字可带负号）`,
      locs: [tok],
    });
    return null;
  }
  const lit = Number(tok.text);
  if (nvars != null && Math.abs(lit) > nvars) {
    errors.push({
      scope,
      code: 'VARIABLE_OUT_OF_RANGE',
      message: `文字 ${lit} 的变量编号超出题头声明的变量数 ${nvars}（越界）`,
      locs: [tok],
    });
  }
  return lit;
}

function checkDuplicateOrComplement(lit, tok, seenByVar, errors, scope) {
  const v = Math.abs(lit);
  const prev = seenByVar.get(v);
  if (!prev) {
    seenByVar.set(v, { lit, tok });
    return;
  }
  if (prev.lit === lit) {
    errors.push({
      scope,
      code: 'DUPLICATE_LITERAL',
      message: `文字 ${lit} 在同一条目内重复出现`,
      locs: [prev.tok, tok],
    });
  } else {
    errors.push({
      scope,
      code: 'COMPLEMENTARY_LITERALS',
      message: `文字 ${prev.lit} 与 ${lit} 互补，该子句是永真式，属于非法冗余条目`,
      locs: [prev.tok, tok],
    });
  }
}

/**
 * 解析受限 DIMACS CNF。
 * 支持 `c` 注释行与 `p cnf <变量数> <子句数>` 题头（题头可省略，
 * 省略时不做越界检查）。子句允许跨行，但只允许以 0 结束。
 */
export function parseCNF(text) {
  const lines = tokenize(text);
  const errors = [];
  const clauses = [];
  let header = null;

  let pending = []; // {lit, tok}
  const finishClause = (endTok) => {
    clauses.push({
      lits: pending.map((p) => p.lit),
      locs: pending.map((p) => p.tok),
      end: endTok,
    });
    pending = [];
  };

  for (const line of lines) {
    if (line.tokens.length === 0) continue;
    const first = line.tokens[0];

    // 注释行：即使在跨行子句中途，受限方言也整行忽略（其内容不参与语法）。
    if (first.text === 'c') continue;

    // 题头只允许出现在子句边界。
    if (first.text === 'p' && pending.length === 0) {
      const t = line.tokens;
      const n = Number(t[2]?.text);
      const declaredClauses = Number(t[3]?.text);
      if (
        t.length !== 4 ||
        t[1]?.text !== 'cnf' ||
        !/^\d+$/.test(t[2]?.text ?? '') ||
        !/^\d+$/.test(t[3]?.text ?? '')
      ) {
        errors.push({
          scope: 'cnf',
          code: 'BAD_HEADER',
          message: '题头格式应为 “p cnf <变量数> <子句数>”，且变量数为非负正整数声明',
          locs: [{ line: line.no, col: 1, text: line.text }],
        });
      } else {
        header = { nvars: n, declaredClauses, loc: first };
      }
      continue;
    }

    const nvars = header?.nvars ?? null;
    const seenByVar = new Map(pending.map((p) => [Math.abs(p.lit), p]));

    for (const tok of line.tokens) {
      if (tok.text === '0') {
        if (pending.length === 0) {
          errors.push({
            scope: 'cnf',
            code: 'EMPTY_CLAUSE_FORBIDDEN',
            message: 'CNF 中不允许出现空子句：空矛盾仅可作为 DRAT 回放的最终一步',
            locs: [tok],
          });
        } else {
          finishClause(tok);
        }
        seenByVar.clear();
        continue;
      }
      const lit = parseLiteralToken(tok, nvars, errors, 'cnf');
      if (lit == null) continue;
      checkDuplicateOrComplement(lit, tok, seenByVar, errors, 'cnf');
      pending.push({ lit, tok });
    }
  }

  if (pending.length > 0) {
    const last = pending[pending.length - 1].tok;
    errors.push({
      scope: 'cnf',
      code: 'TRUNCATED_CLAUSE',
      message: `最后一条子句缺少结束符 0（截断），已有 ${pending.length} 个文字未结案`,
      locs: [last],
    });
  }

  return { header, clauses, errors, lines };
}

/**
 * 解析顺序排列的 DRAT 加/删记录，每行一条：
 *   加：<l1> <l2> ... 0
 *   删：d <l1> <l2> ... 0
 * 空加子句 “0” 表示空矛盾，语义层要求它只能是最后一条记录。
 */
export function parseDRAT(text, nvars = null) {
  const lines = tokenize(text);
  const errors = [];
  const records = [];

  for (const line of lines) {
    if (line.tokens.length === 0) continue;
    if (line.tokens[0].text === 'c') continue;

    let cursor = 0;
    let del = false;
    const dTok = line.tokens[0];
    if (dTok.text === 'd') {
      del = true;
      cursor = 1;
    }

    const lits = [];
    const locs = [];
    const seenByVar = new Map();
    let termLoc = null;
    let extraTokens = [];

    if (del && line.tokens.length === 1) {
      errors.push({
        scope: 'drat',
        code: 'TRUNCATED_RECORD',
        message: '删除记录只有 “d”，缺少子句文字与结束符 0（截断）',
        locs: [dTok],
      });
    }

    for (; cursor < line.tokens.length; cursor++) {
      const tok = line.tokens[cursor];
      if (tok.text === '0') {
        if (termLoc) {
          // 第二个 0：其后的一切都属于多余记号。
          extraTokens.push(tok);
          continue;
        }
        termLoc = tok;
        continue;
      }
      if (termLoc) {
        extraTokens.push(tok);
        continue;
      }
      const lit = parseLiteralToken(tok, nvars, errors, 'drat');
      if (lit == null) continue;
      checkDuplicateOrComplement(lit, tok, seenByVar, errors, 'drat');
      lits.push(lit);
      locs.push(tok);
    }

    if (extraTokens.length > 0) {
      errors.push({
        scope: 'drat',
        code: 'TOKENS_AFTER_TERMINATOR',
        message: '记录在结束符 0 之后仍有多余记号，每条记录独占一行',
        locs: extraTokens,
      });
    }

    if (!termLoc) {
      const anchor = locs[locs.length - 1] ?? dTok;
      errors.push({
        scope: 'drat',
        code: 'TRUNCATED_RECORD',
        message: `${del ? '删除' : '添加'}记录缺少结束符 0（截断）`,
        locs: [anchor],
      });
    }

    if (del && lits.length === 0 && termLoc) {
      errors.push({
        scope: 'drat',
        code: 'DELETE_EMPTY_CLAUSE',
        message: '删除记录未给出任何文字，空矛盾不得作为删除目标',
        locs: [termLoc],
      });
    }

    records.push({
      index: records.length + 1,
      line: line.no,
      del,
      lits,
      locs,
      termLoc,
      dTok: del ? dTok : null,
    });
  }

  return { records, errors, lines };
}
