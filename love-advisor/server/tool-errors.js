export const TOOL_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  TOOL_UNAVAILABLE: 'TOOL_UNAVAILABLE',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  TEMPORARY_FAILURE: 'TEMPORARY_FAILURE',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  TOOL_CANCELLED: 'TOOL_CANCELLED',
  TOOL_EXECUTION_FAILED: 'TOOL_EXECUTION_FAILED',
})

export const TOOL_RECOVERY_STRATEGIES = Object.freeze({
  REVISE_INPUT: 'REVISE_INPUT',
  USE_ALTERNATIVE: 'USE_ALTERNATIVE',
  ASK_USER: 'ASK_USER',
  STOP: 'STOP',
})

const KNOWN_CODES = new Set(Object.values(TOOL_ERROR_CODES))
const KNOWN_RECOVERY_STRATEGIES = new Set(Object.values(TOOL_RECOVERY_STRATEGIES))
const DEFAULT_RECOVERY_BY_CODE = Object.freeze({
  [TOOL_ERROR_CODES.INVALID_ARGUMENT]: TOOL_RECOVERY_STRATEGIES.REVISE_INPUT,
  [TOOL_ERROR_CODES.PERMISSION_DENIED]: TOOL_RECOVERY_STRATEGIES.STOP,
  [TOOL_ERROR_CODES.UNKNOWN_TOOL]: TOOL_RECOVERY_STRATEGIES.USE_ALTERNATIVE,
  [TOOL_ERROR_CODES.TOOL_UNAVAILABLE]: TOOL_RECOVERY_STRATEGIES.USE_ALTERNATIVE,
  [TOOL_ERROR_CODES.PRECONDITION_FAILED]: TOOL_RECOVERY_STRATEGIES.ASK_USER,
  [TOOL_ERROR_CODES.LIMIT_EXCEEDED]: TOOL_RECOVERY_STRATEGIES.USE_ALTERNATIVE,
  [TOOL_ERROR_CODES.TEMPORARY_FAILURE]: TOOL_RECOVERY_STRATEGIES.USE_ALTERNATIVE,
  [TOOL_ERROR_CODES.TOOL_TIMEOUT]: TOOL_RECOVERY_STRATEGIES.USE_ALTERNATIVE,
  [TOOL_ERROR_CODES.TOOL_CANCELLED]: TOOL_RECOVERY_STRATEGIES.STOP,
  [TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED]: TOOL_RECOVERY_STRATEGIES.USE_ALTERNATIVE,
})

export function recoveryForToolError(code) {
  return DEFAULT_RECOVERY_BY_CODE[code] || TOOL_RECOVERY_STRATEGIES.USE_ALTERNATIVE
}

export class ToolExecutionError extends Error {
  constructor(code, message, { retryable = false, recovery, cause } = {}) {
    super(String(message || '工具执行失败'), cause === undefined ? undefined : { cause })
    this.name = 'ToolExecutionError'
    this.code = KNOWN_CODES.has(code) ? code : TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED
    this.retryable = retryable === true
    this.recovery = KNOWN_RECOVERY_STRATEGIES.has(recovery)
      ? recovery
      : recoveryForToolError(this.code)
  }
}

export function toolError(code, message, options) {
  return new ToolExecutionError(code, message, options)
}

export function normalizeToolError(error, { cancelled = false } = {}) {
  if (error instanceof ToolExecutionError) return error
  if (error && KNOWN_CODES.has(error.code)) {
    return new ToolExecutionError(error.code, error.message, {
      retryable: error.retryable === true,
      recovery: error.recovery,
      cause: error,
    })
  }
  if (cancelled || error?.name === 'AbortError') {
    return toolError(TOOL_ERROR_CODES.TOOL_CANCELLED, '工具执行已取消', { cause: error })
  }
  if (error?.name === 'TimeoutError' || ['ETIMEDOUT', 'ETIME'].includes(error?.code)) {
    return toolError(TOOL_ERROR_CODES.TOOL_TIMEOUT, error?.message || '工具执行超时', {
      retryable: true,
      cause: error,
    })
  }
  return toolError(
    TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED,
    error?.message || '工具执行失败',
    { cause: error },
  )
}
