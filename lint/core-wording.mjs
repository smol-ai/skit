import ts from "typescript-parser";

const nativeErrors = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
]);
const proseFields = new Set([
  "message",
  "remediation",
  "detail",
  "problem",
  "reason",
  "question",
  "prompt",
  "issue",
  "entryType",
  "expected",
]);
const textFields = new Set(["detail", "problem", "reason"]);
const authoredTextFields = new Set(["message", "remediation", "question", "prompt", "expected"]);
const nameOf = (node) => {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return ts.isComputedPropertyName(node) ? nameOf(node.expression) : undefined;
};
const memberName = (node) =>
  ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isElementAccessExpression(node)
      ? nameOf(node.argumentExpression)
      : ts.isIdentifier(node)
        ? node.text
        : undefined;
const nativeConstructor = (node) =>
  nativeErrors.has(memberName(node)) &&
  (ts.isIdentifier(node) ||
    ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "globalThis"));
const literalText = (node) =>
  ts.isStringLiteralLike(node)
    ? node.text
    : ts.isTemplateExpression(node)
      ? node.head.text + node.templateSpans.map((span) => "${…}" + span.literal.text).join("")
      : undefined;

const contains = (node, predicate) =>
  predicate(node) ||
  Boolean(ts.forEachChild(node, (child) => contains(child, predicate) || undefined));
const stringValues = (node) => {
  const value = literalText(node);
  if (value !== undefined) return [value];
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return stringValues(node.expression);
  if (ts.isConditionalExpression(node))
    return [...stringValues(node.whenTrue), ...stringValues(node.whenFalse)];
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(stringValues);
  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.PlusToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(node.operatorToken.kind)
  )
    return [...stringValues(node.left), ...stringValues(node.right)];
  return [];
};
const hasProse = (node) =>
  stringValues(node).some((value) => (value.match(/[\p{L}]+(?:-[\p{L}]+)*/gu) ?? []).length > 1);
const nativeDescription = (node) => {
  const call = node.parent.parent;
  return (
    (ts.isNewExpression(call) && (memberName(call.expression) ?? "").endsWith("Error")) ||
    (ts.isCallExpression(call) &&
      ["systemError", "badArgument"].includes(memberName(call.expression)))
  );
};
const openText = (node) => {
  if (ts.isPropertyAccessExpression(node))
    return ["String", "NonEmptyString"].includes(node.name.text);
  if (!ts.isCallExpression(node)) return false;
  const method = memberName(node.expression);
  if (
    ["check", "annotate", "pipe"].includes(method) &&
    ts.isPropertyAccessExpression(node.expression)
  )
    return openText(node.expression.expression);
  if (["optional", "optionalKey", "NullOr", "UndefinedOr", "NullishOr", "Array"].includes(method))
    return node.arguments.some(openText);
  return (
    method === "Union" &&
    node.arguments.some((arg) => ts.isArrayLiteralExpression(arg) && arg.elements.some(openText))
  );
};

/** Syntax guard for authored failure/diagnostic text. Native evidence is passed through, not erased. */
export function coreWordingIssues(text, filename = "core.ts") {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const issues = [];
  const report = (node, kind) =>
    issues.push({
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      kind,
    });
  const failureInterfaces = new Set(["SkitFailure"]);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements) {
        if ((item.propertyName ?? item.name).text === "SkitFailure")
          failureInterfaces.add(item.name.text);
      }
  }
  const visit = (node) => {
    const value = literalText(node);
    if (value !== undefined && /\bskit\s+/.test(value)) report(node, "cli-command");
    if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      nativeConstructor(node.expression)
    )
      report(node, "untyped-error");
    if (
      ts.isCallExpression(node) &&
      ["die", "dieMessage", "fail"].includes(memberName(node.expression)) &&
      node.arguments[0] &&
      literalText(node.arguments[0]) !== undefined
    )
      report(node.arguments[0], "untyped-failure");
    if (
      ts.isCallExpression(node) &&
      ["log", "logWarning", "logInfo", "logDebug", "logError", "logFatal", "logTrace"].includes(
        memberName(node.expression),
      )
    )
      for (const argument of node.arguments)
        if (hasProse(argument)) report(argument, "authored-log");
    if (
      ts.isCallExpression(node) &&
      memberName(node.expression) === "forbidden" &&
      node.arguments[0] &&
      ts.isArrowFunction(node.arguments[0]) &&
      hasProse(node.arguments[0].body)
    )
      report(node.arguments[0], "authored-prose");
    if (
      ts.isCallExpression(node) &&
      memberName(node.expression) === "makeFilter" &&
      node.arguments[0] &&
      (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0])) &&
      (hasProse(node.arguments[0].body) ||
        contains(
          node.arguments[0].body,
          (child) =>
            ts.isReturnStatement(child) &&
            child.expression !== undefined &&
            hasProse(child.expression),
        ))
    )
      report(node.arguments[0], "authored-prose");
    if (
      ts.isPropertyAssignment(node) &&
      (proseFields.has(nameOf(node.name)) ||
        (nameOf(node.name) === "description" && nativeDescription(node))) &&
      (hasProse(node.initializer) ||
        (authoredTextFields.has(nameOf(node.name)) && stringValues(node.initializer).length > 0))
    )
      report(node.name, "authored-prose");
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const clause of node.heritageClauses ?? [])
        if (clause.token === ts.SyntaxKind.ExtendsKeyword)
          for (const base of clause.types)
            if (nativeConstructor(base.expression)) report(base, "untyped-error");
      const failure = node.heritageClauses?.some((clause) =>
        contains(
          clause,
          (child) =>
            (ts.isPropertyAccessExpression(child) && child.name.text === "TaggedError") ||
            (ts.isIdentifier(child) &&
              (failureInterfaces.has(child.text) || nativeErrors.has(child.text))),
        ),
      );
      if (failure) {
        for (const member of node.members) {
          if (["message", "remediation"].includes(nameOf(member.name)))
            report(member.name, "failure-member");
          if (member.body)
            contains(member.body, (child) => {
              if (
                ts.isBinaryExpression(child) &&
                child.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                (ts.isPropertyAccessExpression(child.left) ||
                  ts.isElementAccessExpression(child.left)) &&
                child.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
                ["message", "remediation"].includes(memberName(child.left))
              )
                report(child.left, "failure-member");
              return false;
            });
        }
        for (const clause of node.heritageClauses ?? [])
          contains(clause, (child) => {
            if (
              !ts.isCallExpression(child) ||
              !child.arguments[1] ||
              !ts.isObjectLiteralExpression(child.arguments[1])
            )
              return false;
            for (const field of child.arguments[1].properties) {
              if (!ts.isPropertyAssignment(field)) continue;
              const name = nameOf(field.name);
              if (
                ["message", "remediation"].includes(name) ||
                (textFields.has(name) && openText(field.initializer))
              )
                report(field.name, "failure-field");
            }
            return false;
          });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return issues;
}
