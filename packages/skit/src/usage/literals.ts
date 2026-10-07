import {
  parse,
  type Expression,
  type Literal,
  type Statement,
  type ModuleDeclaration,
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
  const bindings = new Map<string, string>();
  const commands: LiteralCommand[] = [];
  let unsupported = false;
  let visited = 0;
  let depth = 0;
  let depthExceeded = false;
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
        case "ConditionalExpression":
        case "FunctionExpression":
        case "ArrowFunctionExpression":
          unsupported = true;
          return;
        case "BinaryExpression":
          if (node.left.type !== "PrivateIdentifier") expression(node.left);
          expression(node.right);
          return;
        case "AssignmentExpression":
          expression(node.right);
          return;
        case "ChainExpression":
          unsupported = true;
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
        if (node.kind === "const" && declaration.id.type === "Identifier") {
          const value = stringValue(declaration.init ?? undefined);
          if (value !== undefined) bindings.set(declaration.id.name, value);
        }
        expression(declaration.init);
      }
    else if (node.type === "BlockStatement") {
      const outer = new Map(bindings);
      for (const child of node.body) statement(child);
      bindings.clear();
      for (const [name, value] of outer) bindings.set(name, value);
    } else if (node.type !== "EmptyStatement") unsupported = true;
  };
  for (const node of program.body) statement(node);
  if (visited > 50_000 || depthExceeded) return { commands: [], unsupported: true };
  return { commands, unsupported };
}

/** Literal read operands only: no shell expansion, redirects, or command execution. */
export function shellReadPaths(command: string): string[] {
  if (Array.from(command).some((c) => c.charCodeAt(0) < 9) || /[$`<>*?{}]/.test(command)) return [];
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let active = false;
  let quote = "";
  const flush = () => {
    if (active) {
      words.push(word);
      word = "";
      active = false;
    }
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
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
    if (c === "\\") {
      if (i + 1 >= command.length) return [];
      word += command[++i];
      active = true;
      continue;
    }
    if (";\n&|".includes(c)) {
      flush();
      if (words.length) segments.push(words);
      words = [];
      continue;
    }
    if (/\s/.test(c)) {
      flush();
      continue;
    }
    word += c;
    active = true;
  }
  if (quote) return [];
  flush();
  if (words.length) segments.push(words);
  return segments.flatMap(([tool, ...args]) => {
    if (!["cat", "head", "tail", "sed"].includes(tool)) return [];
    if (tool === "sed" && args.some((a) => a === "-i" || a.startsWith("-i"))) return [];
    // Require the exact filename; backups and textual snippets are not reads.
    return args.filter((a) => !a.startsWith("-") && /(?:^|\/)SKILL\.md$/.test(a));
  });
}
