import { create, all } from 'mathjs'

const math = create(all)
const safeEvaluate = math.evaluate.bind(math)

// Disable anything that could be abused from a stored formula
math.import(
  {
    import: () => { throw new Error('Function import is disabled') },
    createUnit: () => { throw new Error('Function createUnit is disabled') },
    reviver: () => { throw new Error('Function reviver is disabled') },
    evaluate: () => { throw new Error('Function evaluate is disabled') },
    parse: () => { throw new Error('Function parse is disabled') },
    simplify: () => { throw new Error('Function simplify is disabled') },
    derivative: () => { throw new Error('Function derivative is disabled') },
  },
  { override: true }
)

const MAX_EXPR_LENGTH = 500

function prepare(code: string): string {
  const expr = code.replace(/^\s*result\s*=\s*/, '').trim()
  if (!expr) throw new Error('Empty expression')
  if (expr.length > MAX_EXPR_LENGTH) throw new Error('Expression too long')
  if (/[;\n]/.test(expr)) throw new Error('Multi-statement expressions are not allowed')
  return expr
}

export function evaluateRuleExpression(code: string, scope: Record<string, any>): number {
  const expr = prepare(code)
  const raw: any = safeEvaluate(expr, scope)
  const value = typeof raw === 'number' ? raw : Number(raw?.valueOf?.() ?? raw)
  if (!Number.isFinite(value)) {
    throw new Error(`Expression did not return a finite number: ${expr}`)
  }
  return value
}

export function evaluateCondition(code: string, scope: Record<string, any>): boolean {
  const expr = prepare(code)
  const raw: any = safeEvaluate(expr, scope)
  if (typeof raw === 'boolean') return raw
  return Number(raw) !== 0
}
