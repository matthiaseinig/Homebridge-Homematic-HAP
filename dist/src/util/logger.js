/**
 * Thin Logger wrapper that adds a stable component prefix and gives us a
 * single chokepoint to (a) attach extra fields uniformly and (b) make
 * sure secrets in args are scrubbed before reaching `log.*`.
 *
 * The plugin never logs CCU credentials. `scrubArgs` walks args and
 * replaces any value whose property name matches /password|secret|token/i.
 */
const SECRET_KEY_RE = /password|secret|token|apikey|api[_-]?key/i;
export function scrubArgs(args) {
    return args.map(scrubValue);
}
function scrubValue(value, depth = 0) {
    if (depth > 4) {
        return '[redacted: depth]';
    }
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((v) => scrubValue(v, depth + 1));
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (SECRET_KEY_RE.test(k)) {
                out[k] = '[redacted]';
            }
            else {
                out[k] = scrubValue(v, depth + 1);
            }
        }
        return out;
    }
    return String(value);
}
export class PrefixedLogger {
    underlying;
    prefix;
    constructor(underlying, prefix) {
        this.underlying = underlying;
        this.prefix = prefix;
    }
    child(suffix) {
        return new PrefixedLogger(this.underlying, `${this.prefix}:${suffix}`);
    }
    info(message, ...args) {
        this.underlying.info(`[${this.prefix}] ${message}`, ...scrubArgs(args));
    }
    success(message, ...args) {
        this.underlying.success(`[${this.prefix}] ${message}`, ...scrubArgs(args));
    }
    warn(message, ...args) {
        this.underlying.warn(`[${this.prefix}] ${message}`, ...scrubArgs(args));
    }
    error(message, ...args) {
        this.underlying.error(`[${this.prefix}] ${message}`, ...scrubArgs(args));
    }
    debug(message, ...args) {
        this.underlying.debug(`[${this.prefix}] ${message}`, ...scrubArgs(args));
    }
}
//# sourceMappingURL=logger.js.map