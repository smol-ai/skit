import {
  parse,
  type Expression,
  type Literal,
  type Statement,
  type ModuleDeclaration,
  type Node,
  type Pattern,
} from "acorn";

export interface LiteralCommand {
  readonly cmd: string;
  readonly cwd?: string;
}
/** Parse a bounded JS module; recover eager literal calls, never execute source. */
export function literalCommands(source: string): {
  commands: LiteralCommand[];
  unsupported: boolean;
} {
  if (source.length > 1024 * 1024) return { commands: [], unsupported: true };
  let program;
  try {
    program = parse(source, {
      ecmaVersion: 2023,
      sourceType: "module",
      allowAwaitOutsideFunction: true,
    });
  } catch {
    return { commands: [], unsupported: true };
  }
  const bindings = new Map<string, string | undefined>();
  const commands: LiteralCommand[] = [];
  let unsupported = false;
  let visited = 0;
  let depth = 0;
  let depthExceeded = false;
  const isExecCall = (node: Node): boolean => {
    if (node.type !== "CallExpression") return false;
    const callee = (node as Extract<Expression, { type: "CallExpression" }>).callee;
    return (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.object.type === "Identifier" &&
      callee.object.name === "tools" &&
      callee.property.type === "Identifier" &&
      callee.property.name === "exec_command"
    );
  };
  // Inspect skipped syntax for actual tool calls, never textual mentions in literals/comments.
  const hasExecCall = (node: Node, level = 0): boolean => {
    if (++visited > 50_000 || level > 250) {
      depthExceeded = true;
      return true;
    }
    if (isExecCall(node)) return true;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value)
          if (
            child &&
            typeof child === "object" &&
            "type" in child &&
            hasExecCall(child, level + 1)
          )
            return true;
      } else if (
        value &&
        typeof value === "object" &&
        "type" in value &&
        hasExecCall(value as Node, level + 1)
      )
        return true;
    }
    return false;
  };
  const invalidatePattern = (pattern: Pattern): void => {
    if (pattern.type === "Identifier") bindings.set(pattern.name, undefined);
    else if (pattern.type === "RestElement") invalidatePattern(pattern.argument);
    else if (pattern.type === "AssignmentPattern") invalidatePattern(pattern.left);
    else if (pattern.type === "ArrayPattern") {
      for (const item of pattern.elements) if (item) invalidatePattern(item);
    } else if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties)
        invalidatePattern(property.type === "RestElement" ? property.argument : property.value);
    }
  };
  // A declaration shadows the outer value throughout its block, including before initialization.
  const declareBlock = (body: readonly (Statement | ModuleDeclaration)[]): void => {
    for (const child of body) {
      if (child.type === "VariableDeclaration")
        for (const declaration of child.declarations) invalidatePattern(declaration.id);
      else if (
        (child.type === "FunctionDeclaration" || child.type === "ClassDeclaration") &&
        child.id
      )
        bindings.set(child.id.name, undefined);
    }
  };
  const stringValue = (node: Expression | Literal | undefined): string | undefined => {
    if (node?.type === "Literal" && typeof node.value === "string") return node.value;
    if (node?.type === "Identifier") return bindings.get(node.name);
    if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
      return node.quasis[0]?.value.cooked ?? undefined;
    return undefined;
  };
  const expression = (node: Expression | Literal | undefined | null): void => {
    if (!node) return;
    if (++visited > 50_000) {
      unsupported = true;
      return;
    }
    if (++depth > 250) {
      depth--;
      depthExceeded = true;
      unsupported = true;
      return;
    }
    try {
      switch (node.type) {
        case "CallExpression": {
          const callee = node.callee;
          if (
            callee.type === "MemberExpression" &&
            !callee.computed &&
            callee.object.type === "Identifier" &&
            callee.object.name === "tools" &&
            callee.property.type === "Identifier" &&
            callee.property.name === "exec_command"
          ) {
            const argument = node.arguments[0];
            let cmd: string | undefined;
            let cwd: string | undefined;
            let invalid = false;
            const keys = new Set<string>();
            if (argument?.type === "ObjectExpression")
              for (const prop of argument.properties) {
                if (
                  prop.type === "SpreadElement" ||
                  prop.computed ||
                  prop.method ||
                  prop.kind !== "init"
                ) {
                  invalid = true;
                  continue;
                }
                const key =
                  prop.key.type === "Identifier"
                    ? prop.key.name
                    : prop.key.type === "Literal"
                      ? prop.key.value
                      : undefined;
                if (key !== "cmd" && key !== "cwd" && key !== "workdir") continue;
                if (keys.has(key)) invalid = true;
                keys.add(key);
                const value = stringValue(prop.value);
                if (value === undefined) invalid = true;
                else if (key === "cmd") cmd = value;
                else cwd = value;
              }
            else invalid = true;
            if (cmd !== undefined && !invalid) commands.push({ cmd, ...(cwd ? { cwd } : {}) });
            else unsupported = true;
          }
          if (callee.type !== "Super") expression(callee);
          for (const arg of node.arguments) if (arg.type !== "SpreadElement") expression(arg);
          return;
        }
        case "AwaitExpression":
        case "UnaryExpression":
        case "UpdateExpression":
          expression(node.argument);
          return;
        case "ArrayExpression":
          for (const item of node.elements) if (item?.type !== "SpreadElement") expression(item);
          return;
        case "ObjectExpression":
          for (const prop of node.properties)
            if (prop.type === "Property") {
              if (prop.computed) expression(prop.key);
              expression(prop.value);
            }
          return;
        case "MemberExpression":
          if (node.object.type !== "Super") expression(node.object);
          if (node.computed && node.property.type !== "PrivateIdentifier")
            expression(node.property);
          return;
        case "SequenceExpression":
          for (const item of node.expressions) expression(item);
          return;
        // Conditional/short-circuit/function bodies do not prove an eager call.
        case "LogicalExpression":
          expression(node.left);
          if (hasExecCall(node.right)) unsupported = true;
          return;
        case "ConditionalExpression":
          expression(node.test);
          if (hasExecCall(node.consequent) || hasExecCall(node.alternate)) unsupported = true;
          return;
        case "FunctionExpression":
        case "ArrowFunctionExpression":
          if (hasExecCall(node)) unsupported = true;
          return;
        case "BinaryExpression":
          if (node.left.type !== "PrivateIdentifier") expression(node.left);
          expression(node.right);
          return;
        case "AssignmentExpression":
          expression(node.right);
          if (node.left.type !== "MemberExpression") invalidatePattern(node.left);
          return;
        case "ChainExpression":
          if (hasExecCall(node)) unsupported = true;
          return;
        default:
          return;
      }
    } finally {
      depth--;
    }
  };
  const statement = (node: Statement | ModuleDeclaration): void => {
    if (node.type === "ExpressionStatement") expression(node.expression);
    else if (node.type === "VariableDeclaration")
      for (const declaration of node.declarations) {
        invalidatePattern(declaration.id);
        if (node.kind === "const" && declaration.id.type === "Identifier") {
          const value = stringValue(declaration.init ?? undefined);
          if (value !== undefined) bindings.set(declaration.id.name, value);
        }
        expression(declaration.init);
      }
    else if (node.type === "BlockStatement") {
      const outer = new Map(bindings);
      declareBlock(node.body);
      for (const child of node.body) statement(child);
      bindings.clear();
      for (const [name, value] of outer) bindings.set(name, value);
    } else if (node.type !== "EmptyStatement" && hasExecCall(node)) unsupported = true;
  };
  declareBlock(program.body);
  for (const node of program.body) statement(node);
  if (visited > 50_000 || depthExceeded) return { commands: [], unsupported: true };
  return { commands, unsupported };
}

/** Literal read operands only. Unsupported syntax invalidates its segment, not adjacent commands. */
export function shellReadPaths(command: string): string[] {
  if (Array.from(command).some((c) => c.charCodeAt(0) < 9)) return [];
  const segments: { words: string[]; unsafe: boolean }[] = [];
  let words: string[] = [];
  let word = "";
  let active = false;
  let quote = "";
  let unsafe = false;
  const nesting: string[] = [];
  let nestedQuote = "";
  let backtick = false;
  const flushWord = () => {
    if (active) {
      words.push(word);
      word = "";
      active = false;
    }
  };
  const flushSegment = () => {
    flushWord();
    if (words.length) segments.push({ words, unsafe });
    words = [];
    unsafe = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (backtick) {
      if (c === "\\") i++;
      else if (c === "`") backtick = false;
      continue;
    }
    if (nesting.length) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (nestedQuote) {
        if (c === nestedQuote) nestedQuote = "";
      } else if (c === "'" || c === '"' || c === "`") nestedQuote = c;
      else if (c === "(") nesting.push(")");
      else if (c === "{") nesting.push("}");
      else if (c === nesting.at(-1)) nesting.pop();
      continue;
    }
    if (c === "\\" && quote !== "'") {
      if (i + 1 >= command.length) {
        unsafe = true;
        break;
      }
      const next = command[++i];
      if (next !== "\n") {
        word += next;
        active = true;
      }
      continue;
    }
    if (quote === "'") {
      if (c === quote) quote = "";
      else word += c;
      active = true;
      continue;
    }
    if (c === "$" || c === "`") {
      unsafe = true;
      if (c === "`") backtick = true;
      else if (command[i + 1] === "(" || command[i + 1] === "{") {
        nesting.push(command[++i] === "(" ? ")" : "}");
      }
      word += c;
      active = true;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      else word += c;
      active = true;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      active = true;
      continue;
    }
    if (c === "#" && !active) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
      continue;
    }
    if (c === "(" || c === "{") {
      unsafe = true;
      nesting.push(c === "(" ? ")" : "}");
    }
    // Heredoc bodies are data, not commands. Their delimiter semantics are unsupported.
    if (c === "<" && command[i + 1] === "<") return [];
    if ("<>*?{}()".includes(c)) unsafe = true;
    if (";\n&|".includes(c)) {
      flushSegment();
      continue;
    }
    if (/\s/.test(c)) {
      flushWord();
      continue;
    }
    word += c;
    active = true;
  }
  if (quote || nesting.length || backtick) unsafe = true;
  flushSegment();
  return segments.flatMap(({ words: [tool, ...args], unsafe }) => {
    if (unsafe || !["cat", "head", "tail", "sed"].includes(tool)) return [];
    if (tool === "sed" && args.some((a) => a === "-i" || a.startsWith("-i"))) return [];
    let scriptSeen = tool !== "sed" || args.some((a) => a === "-e" || a === "-f");
    let scriptArgument = false;
    return args.filter((arg) => {
      if (scriptArgument) {
        scriptArgument = false;
        return false;
      }
      if (tool === "sed" && (arg === "-e" || arg === "-f")) {
        scriptArgument = true;
        return false;
      }
      if (arg.startsWith("-")) return false;
      if (!scriptSeen) {
        scriptSeen = true;
        return false;
      }
      return /(?:^|\/)SKILL\.md$/.test(arg);
    });
  });
}
