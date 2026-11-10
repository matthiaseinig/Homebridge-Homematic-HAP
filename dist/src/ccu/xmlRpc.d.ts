/**
 * Tiny, focused XML-RPC parser/serializer.
 *
 * We use this only inside the EventServer so we can audit every line of
 * XML handling — a blanket dependency on a generic XML parser broadens
 * the attack surface for a process that listens on the LAN. The parser
 * supports the subset the CCU uses: methodCall, methodResponse,
 * params/param/value, and the value types int/i4/double/boolean/string/
 * dateTime.iso8601/base64/array/struct.
 *
 * It deliberately does NOT support entities or external DOCTYPEs (XXE
 * attacks are otherwise trivially exploitable on a LAN service).
 */
export interface ParsedCall {
    method: string;
    params: unknown[];
}
export declare function parseXml(body: string): ParsedCall;
export declare function serializeResponse(value: unknown): string;
export declare function serializeFault(code: number, message: string): string;
