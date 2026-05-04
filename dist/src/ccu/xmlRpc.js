const ENTITY_MAP = {
  amp: "&",
  lt: "<",
  gt: ">",
  apos: "'",
  quot: '"'
};
class Cursor {
  constructor(src, i = 0) {
    this.src = src;
    this.i = i;
  }
  src;
  i;
  rest() {
    return this.src.slice(this.i);
  }
  skipWhitespace() {
    while (this.i < this.src.length && /\s/.test(this.src[this.i] ?? "")) {
      this.i++;
    }
  }
  skipDeclarations() {
    while (true) {
      this.skipWhitespace();
      if (this.src.startsWith("<?xml", this.i)) {
        const end = this.src.indexOf("?>", this.i);
        if (end === -1) {
          throw new Error("Unterminated XML declaration");
        }
        this.i = end + 2;
        continue;
      }
      if (this.src.startsWith("<!--", this.i)) {
        const end = this.src.indexOf("-->", this.i);
        if (end === -1) {
          throw new Error("Unterminated comment");
        }
        this.i = end + 3;
        continue;
      }
      if (this.src.startsWith("<!", this.i)) {
        throw new Error("DOCTYPE / DTD not allowed");
      }
      return;
    }
  }
  expect(token) {
    if (!this.src.startsWith(token, this.i)) {
      throw new Error(`Expected ${token} at offset ${this.i}`);
    }
    this.i += token.length;
  }
  consumeText(until) {
    const idx = this.src.indexOf(until, this.i);
    if (idx === -1) {
      throw new Error(`Expected ${until}`);
    }
    const text = this.src.slice(this.i, idx);
    this.i = idx;
    return text;
  }
  peekTag() {
    this.skipWhitespace();
    if (this.src[this.i] !== "<") {
      throw new Error(`Expected '<' at offset ${this.i}`);
    }
    const close = this.src.indexOf(">", this.i);
    if (close === -1) {
      throw new Error("Unterminated tag");
    }
    let tag = this.src.slice(this.i + 1, close).trim().split(/\s+/)[0];
    if (tag.endsWith("/")) {
      tag = tag.slice(0, -1);
    }
    return tag;
  }
  /** Match a self-closing tag like <nil/>. Returns true if matched. */
  trySelfClosing(name) {
    this.skipWhitespace();
    if (this.src.startsWith(`<${name}/>`, this.i)) {
      this.i += name.length + 3;
      return true;
    }
    return false;
  }
  openTag(name) {
    this.skipWhitespace();
    this.expect(`<${name}>`);
  }
  closeTag(name) {
    this.skipWhitespace();
    this.expect(`</${name}>`);
  }
  /** Try to open `<name>` — return true if matched, false otherwise. */
  tryOpenTag(name) {
    this.skipWhitespace();
    if (this.src.startsWith(`<${name}>`, this.i)) {
      this.i += name.length + 2;
      return true;
    }
    return false;
  }
  tryCloseTag(name) {
    this.skipWhitespace();
    if (this.src.startsWith(`</${name}>`, this.i)) {
      this.i += name.length + 3;
      return true;
    }
    return false;
  }
}
function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = parseInt(body.slice(2), 16);
      if (!Number.isFinite(code)) {
        return m;
      }
      return String.fromCodePoint(code);
    }
    if (body.startsWith("#")) {
      const code = parseInt(body.slice(1), 10);
      if (!Number.isFinite(code)) {
        return m;
      }
      return String.fromCodePoint(code);
    }
    const replacement = ENTITY_MAP[body];
    return replacement ?? m;
  });
}
function encodeEntities(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function parseValue(c) {
  c.openTag("value");
  c.skipWhitespace();
  if (c.src.startsWith("</value>", c.i)) {
    c.closeTag("value");
    return "";
  }
  if (c.src[c.i] !== "<") {
    const text = c.consumeText("</value>");
    c.closeTag("value");
    return decodeEntities(text);
  }
  const tag = c.peekTag();
  let result;
  switch (tag) {
    case "string": {
      c.openTag("string");
      const text = c.consumeText("</string>");
      c.closeTag("string");
      result = decodeEntities(text);
      break;
    }
    case "int":
    case "i4": {
      c.openTag(tag);
      const text = c.consumeText(`</${tag}>`);
      c.closeTag(tag);
      const n = parseInt(text.trim(), 10);
      if (!Number.isFinite(n)) {
        throw new Error(`Invalid <${tag}> value`);
      }
      result = n;
      break;
    }
    case "double": {
      c.openTag("double");
      const text = c.consumeText("</double>");
      c.closeTag("double");
      const n = parseFloat(text.trim());
      if (!Number.isFinite(n)) {
        throw new Error("Invalid <double> value");
      }
      result = n;
      break;
    }
    case "boolean": {
      c.openTag("boolean");
      const text = c.consumeText("</boolean>");
      c.closeTag("boolean");
      result = text.trim() === "1";
      break;
    }
    case "array": {
      c.openTag("array");
      c.openTag("data");
      const items = [];
      while (!c.tryCloseTag("data")) {
        items.push(parseValue(c));
      }
      c.closeTag("array");
      result = items;
      break;
    }
    case "struct": {
      c.openTag("struct");
      const obj = {};
      while (!c.tryCloseTag("struct")) {
        c.openTag("member");
        c.openTag("name");
        const name = decodeEntities(c.consumeText("</name>"));
        c.closeTag("name");
        const v = parseValue(c);
        c.closeTag("member");
        obj[name] = v;
      }
      result = obj;
      break;
    }
    case "base64": {
      c.openTag("base64");
      const text = c.consumeText("</base64>");
      c.closeTag("base64");
      result = Buffer.from(text.trim(), "base64");
      break;
    }
    case "dateTime.iso8601": {
      c.openTag("dateTime.iso8601");
      const text = c.consumeText("</dateTime.iso8601>");
      c.closeTag("dateTime.iso8601");
      result = text.trim();
      break;
    }
    case "nil":
    case "ex:nil": {
      if (!c.trySelfClosing(tag)) {
        c.openTag(tag);
        c.closeTag(tag);
      }
      result = null;
      break;
    }
    default:
      throw new Error(`Unsupported XML-RPC value type: ${tag}`);
  }
  c.closeTag("value");
  return result;
}
function parseParams(c) {
  if (!c.tryOpenTag("params")) {
    return [];
  }
  const out = [];
  while (c.tryOpenTag("param")) {
    out.push(parseValue(c));
    c.closeTag("param");
  }
  c.closeTag("params");
  return out;
}
function parseXml(body) {
  const c = new Cursor(body);
  c.skipDeclarations();
  c.openTag("methodCall");
  c.openTag("methodName");
  const method = c.consumeText("</methodName>").trim();
  c.closeTag("methodName");
  const params = parseParams(c);
  c.closeTag("methodCall");
  return { method, params };
}
function serializeValue(value) {
  if (value === null || value === void 0) {
    return "<value><nil/></value>";
  }
  if (typeof value === "boolean") {
    return `<value><boolean>${value ? "1" : "0"}</boolean></value>`;
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return `<value><i4>${value}</i4></value>`;
    }
    return `<value><double>${value}</double></value>`;
  }
  if (typeof value === "string") {
    return `<value><string>${encodeEntities(value)}</string></value>`;
  }
  if (Array.isArray(value)) {
    return `<value><array><data>${value.map(serializeValue).join("")}</data></array></value>`;
  }
  if (Buffer.isBuffer(value)) {
    return `<value><base64>${value.toString("base64")}</base64></value>`;
  }
  if (typeof value === "object") {
    const members = Object.entries(value).map(([k, v]) => `<member><name>${encodeEntities(k)}</name>${serializeValue(v)}</member>`).join("");
    return `<value><struct>${members}</struct></value>`;
  }
  return "<value><string></string></value>";
}
function serializeResponse(value) {
  return `<?xml version="1.0"?><methodResponse><params><param>${serializeValue(value)}</param></params></methodResponse>`;
}
function serializeFault(code, message) {
  return '<?xml version="1.0"?><methodResponse><fault>' + serializeValue({ faultCode: code, faultString: message }) + "</fault></methodResponse>";
}
export {
  parseXml,
  serializeFault,
  serializeResponse
};
//# sourceMappingURL=xmlRpc.js.map
