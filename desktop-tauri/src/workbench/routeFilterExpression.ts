type SqlValue = string | number | boolean | null;
type TruthValue = boolean | null;
type Predicate = (properties: Record<string, unknown>) => SqlValue | TruthValue;

type Token = {
  kind: "identifier" | "string" | "number" | "operator" | "eof";
  value: string;
  position: number;
  quoted?: boolean;
};

const MAX_EXPRESSION_LENGTH = 4096;
const MAX_TOKENS = 512;
const MAX_NESTING = 64;

function expressionError(message: string, position: number): Error {
  return new Error(`${message}（第 ${position + 1} 位）`);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const push = (token: Token) => {
    tokens.push(token);
    if (tokens.length > MAX_TOKENS)
      throw expressionError("表达式包含过多词元", token.position);
  };

  while (index < source.length) {
    const char = source[index];
    if (/\s/u.test(char)) {
      index++;
      continue;
    }
    const start = index;
    if (char === '"') {
      index++;
      let value = "";
      let closed = false;
      while (index < source.length) {
        if (source[index] === '"') {
          if (source[index + 1] === '"') {
            value += '"';
            index += 2;
          } else {
            index++;
            closed = true;
            break;
          }
        } else value += source[index++];
      }
      if (!closed) throw expressionError("字段名的双引号未闭合", start);
      push({ kind: "identifier", value, position: start, quoted: true });
      continue;
    }
    if (char === "'") {
      index++;
      let value = "";
      let closed = false;
      while (index < source.length) {
        if (source[index] === "'") {
          if (source[index + 1] === "'") {
            value += "'";
            index += 2;
          } else {
            index++;
            closed = true;
            break;
          }
        } else value += source[index++];
      }
      if (!closed) throw expressionError("字符串的单引号未闭合", start);
      push({ kind: "string", value, position: start });
      continue;
    }
    if (
      /[0-9]/u.test(char) ||
      (char === "." && /[0-9]/u.test(source[index + 1] ?? ""))
    ) {
      const rest = source.slice(index);
      const match = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u);
      if (!match) throw expressionError("数字格式无效", start);
      index += match[0].length;
      push({ kind: "number", value: match[0], position: start });
      continue;
    }
    if (/[\p{L}_$]/u.test(char)) {
      index++;
      while (index < source.length && /[\p{L}\p{N}_$]/u.test(source[index]))
        index++;
      push({
        kind: "identifier",
        value: source.slice(start, index),
        position: start,
      });
      continue;
    }
    const two = source.slice(index, index + 2);
    if (["<=", ">=", "<>", "!="].includes(two)) {
      index += 2;
      push({ kind: "operator", value: two, position: start });
      continue;
    }
    if (["=", "<", ">", "(", ")", ",", "-"].includes(char)) {
      index++;
      push({ kind: "operator", value: char, position: start });
      continue;
    }
    throw expressionError(`不支持的字符“${char}”`, start);
  }
  tokens.push({ kind: "eof", value: "", position: source.length });
  return tokens;
}

function asSqlValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function compareValues(left: SqlValue, right: SqlValue): number | null {
  if (left === null || right === null) return null;
  if (typeof left === "number" && typeof right === "number")
    return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left !== typeof right) return null;
  if (typeof left === "boolean" && typeof right === "boolean")
    return left === right ? 0 : left ? 1 : -1;
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function requireTruth(
  value: SqlValue | TruthValue,
  position: number,
): TruthValue {
  if (value === null || typeof value === "boolean") return value;
  throw expressionError("WHERE 逻辑运算需要布尔值", position);
}

// 用通配符回溯匹配，避免把用户模式拼成可能产生灾难性回溯的正则表达式。
function matchesLike(
  value: string,
  pattern: string,
  insensitive: boolean,
): boolean {
  const input = Array.from(insensitive ? value.toLocaleLowerCase() : value);
  const source = Array.from(
    insensitive ? pattern.toLocaleLowerCase() : pattern,
  );
  const parts: Array<{ kind: "many" | "one" | "literal"; value?: string }> = [];
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "\\" && index + 1 < source.length) {
      parts.push({ kind: "literal", value: source[++index] });
    } else if (char === "%") {
      if (parts.at(-1)?.kind !== "many") parts.push({ kind: "many" });
    } else if (char === "_") parts.push({ kind: "one" });
    else parts.push({ kind: "literal", value: char });
  }

  let inputIndex = 0;
  let patternIndex = 0;
  let lastMany = -1;
  let retryInput = -1;
  while (inputIndex < input.length) {
    const part = parts[patternIndex];
    if (
      part?.kind === "one" ||
      (part?.kind === "literal" && part.value === input[inputIndex])
    ) {
      inputIndex++;
      patternIndex++;
    } else if (part?.kind === "many") {
      lastMany = patternIndex++;
      retryInput = inputIndex;
    } else if (lastMany >= 0) {
      patternIndex = lastMany + 1;
      inputIndex = ++retryInput;
    } else return false;
  }
  while (parts[patternIndex]?.kind === "many") patternIndex++;
  return patternIndex === parts.length;
}

/** 编译只作用于内存属性快照的安全 SQL WHERE 子集；不会执行数据库 SQL。 */
export function compileRouteFilter(
  expression: string,
  fields: string[],
): (properties: Record<string, unknown>) => boolean {
  if (expression.length > MAX_EXPRESSION_LENGTH)
    throw expressionError("表达式过长", MAX_EXPRESSION_LENGTH);
  if (!expression.trim()) return () => true;
  const tokens = tokenize(expression);
  let cursor = 0;
  let nesting = 0;
  const current = () => tokens[cursor];
  const keyword = (word: string) =>
    current().kind === "identifier" &&
    !current().quoted &&
    current().value.toUpperCase() === word;
  const acceptKeyword = (word: string) => {
    if (!keyword(word)) return false;
    cursor++;
    return true;
  };
  const acceptOperator = (operator: string) => {
    if (current().kind !== "operator" || current().value !== operator)
      return false;
    cursor++;
    return true;
  };
  const expectOperator = (operator: string) => {
    if (!acceptOperator(operator))
      throw expressionError(`需要“${operator}”`, current().position);
  };
  const resolveField = (token: Token): string => {
    const matches = fields.filter((field) =>
      token.quoted
        ? field === token.value
        : field.toLowerCase() === token.value.toLowerCase(),
    );
    if (!matches.length)
      throw expressionError(`未知字段“${token.value}”`, token.position);
    if (matches.length > 1)
      throw expressionError(
        `字段“${token.value}”大小写匹配不唯一，请使用双引号`,
        token.position,
      );
    return matches[0];
  };
  const enter = (position: number) => {
    nesting++;
    if (nesting > MAX_NESTING)
      throw expressionError("表达式嵌套过深", position);
  };

  if (acceptKeyword("WHERE")) {
    // 可直接粘贴以 WHERE 开头的条件片段。
  }

  const parseExpression = (): Predicate => parseOr();
  const parseOr = (): Predicate => {
    let left = parseAnd();
    while (acceptKeyword("OR")) {
      const position = tokens[cursor - 1].position;
      const right = parseAnd();
      const previous = left;
      left = (properties) => {
        const a = requireTruth(previous(properties), position);
        if (a === true) return true;
        const b = requireTruth(right(properties), position);
        if (b === true) return true;
        return a === null || b === null ? null : false;
      };
    }
    return left;
  };
  const parseAnd = (): Predicate => {
    let left = parseNot();
    while (acceptKeyword("AND")) {
      const position = tokens[cursor - 1].position;
      const right = parseNot();
      const previous = left;
      left = (properties) => {
        const a = requireTruth(previous(properties), position);
        if (a === false) return false;
        const b = requireTruth(right(properties), position);
        if (b === false) return false;
        return a === null || b === null ? null : Boolean(a) && Boolean(b);
      };
    }
    return left;
  };
  const parseNot = (): Predicate => {
    const position = current().position;
    if (acceptKeyword("NOT")) {
      const inner = parseNot();
      return (properties) => {
        const value = requireTruth(inner(properties), position);
        return value === null ? null : !Boolean(value);
      };
    }
    return parseComparison();
  };
  const parseComparison = (): Predicate => {
    let left = parseValue();
    const operatorToken = current();
    if (acceptKeyword("IS")) {
      const negate = acceptKeyword("NOT");
      if (!acceptKeyword("NULL"))
        throw expressionError(
          "IS 后只支持 NULL 或 NOT NULL",
          current().position,
        );
      return (properties) => {
        const isNull = left(properties) === null;
        return negate ? !isNull : isNull;
      };
    }
    let negate = false;
    if (keyword("NOT")) {
      cursor++;
      negate = true;
    }
    if (acceptKeyword("IN")) {
      expectOperator("(");
      enter(operatorToken.position);
      const choices: Predicate[] = [];
      if (!acceptOperator(")")) {
        do choices.push(parseValue());
        while (acceptOperator(","));
        expectOperator(")");
      }
      nesting--;
      if (!choices.length)
        throw expressionError("IN 列表不能为空", operatorToken.position);
      return (properties) => {
        const value = left(properties);
        let foundNull = false;
        for (const choice of choices) {
          const compared = compareValues(value, choice(properties));
          if (compared === 0) return negate ? false : true;
          if (compared === null) foundNull = true;
        }
        if (foundNull) return null;
        return negate;
      };
    }
    const isLike = acceptKeyword("LIKE") || acceptKeyword("ILIKE");
    if (isLike) {
      const insensitive =
        operatorToken.value.toUpperCase() === "ILIKE" ||
        tokens[cursor - 1].value.toUpperCase() === "ILIKE";
      const pattern = parseValue();
      return (properties) => {
        const value = left(properties);
        const patternValue = pattern(properties);
        if (value === null || patternValue === null) return null;
        if (typeof value !== "string" || typeof patternValue !== "string")
          return null;
        const matched = matchesLike(value, patternValue, insensitive);
        return negate ? !matched : matched;
      };
    }
    if (negate)
      throw expressionError("NOT 后需要 IN、LIKE 或 ILIKE", current().position);
    if (
      current().kind === "operator" &&
      ["=", "<>", "!=", ">", ">=", "<", "<="].includes(current().value)
    ) {
      const op = current().value;
      cursor++;
      const right = parseValue();
      return (properties) => {
        const compared = compareValues(left(properties), right(properties));
        if (compared === null) return null;
        switch (op) {
          case "=":
            return compared === 0;
          case "<>":
          case "!=":
            return compared !== 0;
          case ">":
            return compared > 0;
          case ">=":
            return compared >= 0;
          case "<":
            return compared < 0;
          default:
            return compared <= 0;
        }
      };
    }
    return (properties) => left(properties);
  };
  const parseValue = (): Predicate => {
    const token = current();
    if (acceptOperator("-")) {
      const numberToken = current();
      if (numberToken.kind !== "number")
        throw expressionError("负号后需要数字", numberToken.position);
      cursor++;
      const value = -Number(numberToken.value);
      if (!Number.isFinite(value))
        throw expressionError("数字超出有效范围", token.position);
      return () => value;
    }
    if (acceptOperator("(")) {
      enter(token.position);
      const inner = parseExpression();
      expectOperator(")");
      nesting--;
      return inner;
    }
    if (token.kind === "string") {
      cursor++;
      return () => token.value;
    }
    if (token.kind === "number") {
      cursor++;
      const value = Number(token.value);
      if (!Number.isFinite(value))
        throw expressionError("数字超出有效范围", token.position);
      return () => value;
    }
    if (acceptKeyword("NULL")) return () => null;
    if (acceptKeyword("TRUE")) return () => true;
    if (acceptKeyword("FALSE")) return () => false;
    if (token.kind !== "identifier")
      throw expressionError("这里需要字段、常量或括号表达式", token.position);
    cursor++;
    if (!token.quoted && acceptOperator("(")) {
      const name = token.value.toLowerCase();
      const supported = [
        "left",
        "right",
        "lower",
        "upper",
        "trim",
        "length",
        "coalesce",
      ];
      if (!supported.includes(name))
        throw expressionError(`未知函数“${token.value}”`, token.position);
      enter(token.position);
      const args: Predicate[] = [];
      if (!acceptOperator(")")) {
        do args.push(parseValue());
        while (acceptOperator(","));
        expectOperator(")");
      }
      nesting--;
      const expected =
        name === "left" || name === "right"
          ? 2
          : ["lower", "upper", "trim", "length"].includes(name)
            ? 1
            : -1;
      if (expected > 0 && args.length !== expected)
        throw expressionError(
          `${name}() 需要 ${expected} 个参数`,
          token.position,
        );
      if (name === "coalesce" && !args.length)
        throw expressionError("coalesce() 至少需要 1 个参数", token.position);
      return (properties) => {
        const values = args.map((arg) => arg(properties));
        if (name === "coalesce")
          return values.find((value) => value !== null) ?? null;
        if (values[0] === null) return null;
        if (typeof values[0] !== "string") return null;
        const chars = Array.from(values[0]);
        if (name === "lower") return values[0].toLocaleLowerCase();
        if (name === "upper") return values[0].toLocaleUpperCase();
        if (name === "trim") return values[0].trim();
        if (name === "length") return chars.length;
        const count = values[1];
        if (typeof count !== "number" || !Number.isInteger(count)) return null;
        const take =
          count < 0
            ? Math.max(chars.length + count, 0)
            : Math.min(count, chars.length);
        return name === "left"
          ? chars.slice(0, take).join("")
          : chars.slice(chars.length - take).join("");
      };
    }
    const field = resolveField(token);
    return (properties) => asSqlValue(properties[field]);
  };

  const predicate = parseExpression();
  if (current().kind !== "eof")
    throw expressionError(
      `无法识别的内容“${current().value}”`,
      current().position,
    );
  return (properties) => requireTruth(predicate(properties), 0) === true;
}
