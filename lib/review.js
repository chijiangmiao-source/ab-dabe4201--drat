// 复核入口：先做受限语法校验（合并定位所有问题），再顺序回放 DRAT。
// 任一层面有错误都不给出 UNSAT 结论——旧结论由调用方在拿到新结果时清除。

import { parseCNF, parseDRAT } from './parser.js';
import { reviewProof } from './checker.js';

export async function review(cnfText, dratText, hooks = {}) {
  const cnf = parseCNF(cnfText);
  const drat = parseDRAT(dratText, cnf.header?.nvars ?? null);

  const inputErrors = [...cnf.errors, ...drat.errors].map((e) => ({
    scope: e.scope,
    code: e.code,
    message: e.message,
    locations: (e.locs ?? []).map((l) => ({
      line: l.line,
      col: l.col,
      text: l.text,
    })),
  }));

  if (inputErrors.length > 0) {
    return {
      verdict: 'INPUT_ERROR',
      message: `输入未通过受限语法校验，共 ${inputErrors.length} 处问题；已定位如下，未进行证明回放，任何旧结论作废`,
      inputErrors,
      errorSummary: summarizeErrors(inputErrors),
      header: cnf.header
        ? { nvars: cnf.header.nvars, declaredClauses: cnf.header.declaredClauses }
        : null,
    };
  }

  const result = await reviewProof(cnf, drat, hooks);
  result.header = cnf.header
    ? { nvars: cnf.header.nvars, declaredClauses: cnf.header.declaredClauses }
    : null;
  result.cnfClauseCount = cnf.clauses.length;
  result.recordCount = drat.records.length;
  return result;
}

function summarizeErrors(errors) {
  const byCode = new Map();
  for (const e of errors) {
    byCode.set(e.code, (byCode.get(e.code) ?? 0) + 1);
  }
  return [...byCode.entries()].map(([code, count]) => ({ code, count }));
}
