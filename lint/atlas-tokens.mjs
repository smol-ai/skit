import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const directory = "packages/storybook/web/src/";
const theme = readFileSync(resolve(root, directory, "fluid-utilities.css"), "utf8");
const names = (prefix) =>
  new Set(
    [...theme.matchAll(new RegExp(`--${prefix}-([a-z0-9-]+)\\s*:`, "g"))]
      .map((m) => m[1])
      .filter((name) => !name.includes("--")),
  );
const sizes = names("text"),
  weights = names("font-weight"),
  spaces = names("spacing"),
  colors = names("color");
const spacingPixels = new Set(
  [...theme.matchAll(/--spacing-[a-z0-9-]+:\s*(\d+)px;/g)].map((m) => m[1]),
);
const fonts = new Set([...names("font")].filter((name) => !name.startsWith("weight-")));
// The only owned hand-written CSS: terminal/ANSI/issue/spinner rendering and
// Inter's font-face. Fluid is vendored; all other owned styling is token utilities.
const cssExceptions = new Set(["components/terminal-frame.css", "fonts.css"]);
const stylesheets = (path) =>
  readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);
    if (child === resolve(root, directory, "fluid")) return [];
    return entry.isDirectory() ? stylesheets(child) : entry.name.endsWith(".css") ? [child] : [];
  });
const textLayout = new Set([
  "left",
  "right",
  "center",
  "justify",
  "start",
  "end",
  "wrap",
  "nowrap",
  "balance",
  "pretty",
  "ellipsis",
  "clip",
]);
const inheritedColors = new Set(["transparent", "current"]);
const protectedStyle =
  /^(?:all|cssText|font.*|lineHeight|letterSpacing|color|background.*|border.*|outline.*|boxShadow|textShadow|fill|stroke|.*Color|(?:padding|margin|gap|rowGap|columnGap).*|line-height|letter-spacing|box-shadow|text-shadow|.*gap)$/;

/** Inspect only the token-controlled families. Other layout utilities stay available. */
function utilityError(candidate) {
  let start = 0,
    brackets = 0;
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] === "[") brackets++;
    else if (candidate[i] === "]") brackets--;
    else if (candidate[i] === ":" && brackets === 0) start = i + 1;
  }
  const base = candidate.slice(start).replace(/^!|!$/g, "");
  // Arbitrary variants/properties can contain colons; inspect their declarations too.
  if (
    /\[(?:font|line-height|letter-spacing|color|background|border-radius|padding|margin|gap|--(?:text|color|spacing|font-weight))[:-]/.test(
      candidate,
    )
  )
    return true;
  if (base.startsWith("outline-offset-")) return !spacingPixels.has(base.slice(15));
  if (/^leading-|^tracking-|^-?rounded(?:-|$)/.test(base)) return true;
  if (base.startsWith("text-")) {
    const value = base.slice(5);
    return (
      !sizes.has(value) &&
      !colors.has(value) &&
      !textLayout.has(value) &&
      !inheritedColors.has(value)
    );
  }
  if (base.startsWith("font-")) return !weights.has(base.slice(5)) && !fonts.has(base.slice(5));
  const spacing = base.match(
    /^(-?)(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]|scroll-[mp][xytrblse]?|indent|inset(?:-[xy])?|top|right|bottom|left|start|end)-(.+)$/,
  );
  if (spacing) return spacing[1] !== "" || (!spaces.has(spacing[2]) && spacing[2] !== "auto");
  const color = base.match(
    /^(bg|border(?:-[xytrblse])?|divide|ring(?:-offset)?|outline|decoration|fill|stroke|accent|caret|placeholder|shadow|from|via|to)-(.+)$/,
  );
  if (color) {
    const [, family, value] = color;
    if (family === "divide" && (value === "x" || value === "y")) return false;
    if (colors.has(value) || inheritedColors.has(value) || value === "none") return false;
    // Width/style controls are not colour choices.
    if (
      /^(border|divide|ring|outline|stroke)/.test(family) &&
      /^(?:\d+|solid|dashed|dotted|double|hidden|collapse|separate)$/.test(value)
    )
      return false;
    if (
      family === "bg" &&
      /^(?:cover|contain|auto|center|top|bottom|left|right|repeat|no-repeat|fixed|local|scroll|clip-\w+|origin-\w+)$/.test(
        value,
      )
    )
      return false;
    return true;
  }
  return false;
}

export const atlasTokenRule = {
  meta: {
    type: "problem",
    schema: [],
    docs: { description: "Use the declared Atlas design tokens in every owned view" },
    messages: {
      token: "Use a declared Atlas token utility instead of '{{value}}'.",
      unknown:
        "Cannot resolve {{sink}} to fixed choices; use constants, conditionals or a closed lookup table.",
      stylesheet:
        "Atlas styling is token utilities only; {{value}}. Hand-written CSS exceptions: components/terminal-frame.css (terminal/ANSI/issue/spinner), fonts.css (font-face).",
      style: "Use token utilities instead of inline '{{value}}'.",
    },
  },
  create(context) {
    const file = relative(root, context.filename).replaceAll("\\", "/");
    if (
      !file.startsWith(directory) ||
      file.startsWith(directory + "fluid/") ||
      file === directory + "components/terminal-frame.ts"
    )
      return {};
    const reported = new Set();
    const report = (node, messageId, value) => {
      const key = `${node.range?.join(":")}:${messageId}:${value}`;
      if (reported.has(key)) return;
      reported.add(key);
      context.report({ node, messageId, data: { value, sink: value } });
    };
    const binding = (node) => {
      let scope = context.sourceCode.getScope(node);
      while (scope) {
        if (scope.set.has(node.name)) return scope.set.get(node.name);
        scope = scope.upper;
      }
    };
    const initial = (node) => {
      const variable = binding(node);
      const definition = variable?.defs.find(
        (d) => d.type === "Variable" && d.parent?.kind === "const",
      );
      if (
        variable?.references.some((reference) => {
          if (reference.isWrite() && !reference.init) return true;
          let member = reference.identifier.parent;
          while (member?.parent?.type === "MemberExpression") member = member.parent;
          if (member?.type !== "MemberExpression") return false;
          const use = member.parent;
          return (
            (use?.type === "AssignmentExpression" && use.left === member) ||
            use?.type === "UpdateExpression" ||
            (use?.type === "CallExpression" &&
              use.callee === member &&
              !["join"].includes(member.property.name))
          );
        })
      )
        return undefined;
      return definition?.node.init;
    };
    const property = (node) =>
      node.computed
        ? node.property.type === "Literal"
          ? String(node.property.value)
          : undefined
        : node.property.name;
    const combine = (left, right) => {
      if (!left || !right || left.length * right.length > 256) return undefined;
      return left.flatMap((a) => right.map((b) => a + b));
    };
    const unwrap = (node, seen = new Set()) => {
      if (!node || seen.has(node)) return undefined;
      if (
        [
          "TSAsExpression",
          "TSSatisfiesExpression",
          "TSNonNullExpression",
          "ParenthesizedExpression",
        ].includes(node.type)
      )
        return unwrap(node.expression, seen);
      if (node.type === "Identifier") {
        const next = new Set(seen);
        next.add(node);
        return unwrap(initial(node), next);
      }
      return node;
    };
    const values = (input, seen = new Set()) => {
      if (!input || seen.has(input)) return undefined;
      const node = unwrap(input, seen);
      if (!node) return undefined;
      const next = new Set(seen);
      next.add(input);
      if (node.type === "Literal")
        return [node.value == null || node.value === false ? "" : String(node.value)];
      if (node.type === "ConditionalExpression") {
        const a = values(node.consequent, next),
          b = values(node.alternate, next);
        return a && b ? [...a, ...b] : undefined;
      }
      if (node.type === "LogicalExpression") {
        const right = values(node.right, next);
        if (node.operator === "&&") return right && ["", ...right];
        const left = values(node.left, next);
        return left && right ? [...left, ...right] : undefined;
      }
      if (node.type === "BinaryExpression" && node.operator === "+")
        return combine(values(node.left, next), values(node.right, next));
      if (node.type === "TemplateLiteral") {
        let result = [node.quasis[0].value.cooked ?? node.quasis[0].value.raw];
        for (let i = 0; i < node.expressions.length; i++)
          result = combine(combine(result, values(node.expressions[i], next)), [
            node.quasis[i + 1].value.cooked ?? node.quasis[i + 1].value.raw,
          ]);
        return result;
      }
      if (node.type === "MemberExpression") {
        const object = unwrap(node.object, next);
        if (
          object?.type !== "ObjectExpression" ||
          object.properties.some((p) => p.type !== "Property")
        )
          return undefined;
        const key = property(node);
        const entries = object.properties.filter(
          (p) => p.type === "Property" && (!key || (p.key.name ?? p.key.value) === key),
        );
        if (!entries.length || (entries.length !== object.properties.length && !key))
          return undefined;
        const found = entries.map((p) => values(p.value, next));
        return found.every(Boolean) ? found.flat() : undefined;
      }
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        property(node.callee) === "join" &&
        node.arguments.length <= 1
      ) {
        const array = unwrap(node.callee.object, next),
          separator = node.arguments.length ? values(node.arguments[0], next) : [","];
        if (array?.type !== "ArrayExpression" || !separator || separator.length !== 1)
          return undefined;
        let result = [""];
        for (let i = 0; i < array.elements.length; i++)
          result = combine(
            combine(result, [i ? separator[0] : ""]),
            values(array.elements[i], next),
          );
        return result;
      }
    };
    const classes = (node) => {
      const choices = values(node);
      if (!choices) return report(node, "unknown", "class expression");
      for (const value of choices)
        for (const candidate of value.split(/\s+/).filter(Boolean)) {
          if (utilityError(candidate)) report(node, "token", candidate);
        }
    };
    const styles = (input) => {
      const node = unwrap(input);
      if (!node) return report(input, "unknown", "style expression");
      if (node.type === "ConditionalExpression") {
        styles(node.consequent);
        styles(node.alternate);
        return;
      }
      if (node.type === "ObjectExpression") {
        for (const entry of node.properties) {
          if (entry.type === "SpreadElement") {
            styles(entry.argument);
            continue;
          }
          if (entry.type !== "Property" || entry.computed) {
            report(entry, "unknown", "style property");
            continue;
          }
          const key = entry.key.name ?? entry.key.value;
          if (protectedStyle.test(key) || key.startsWith("--")) report(entry, "style", key);
        }
        return;
      }
      const choices = values(node);
      if (!choices) return report(input, "unknown", "style expression");
      for (const choice of choices)
        for (const declaration of choice.split(";")) {
          const key = declaration.split(":")[0].trim();
          if (protectedStyle.test(key) || key.startsWith("--")) report(input, "style", key);
        }
    };
    const method = (input) => {
      const node = unwrap(input);
      if (node?.type === "MemberExpression") return property(node);
      if (input?.type === "Identifier") {
        const definition = binding(input)?.defs.find((d) => d.type === "Variable");
        if (definition?.node.id.type === "ObjectPattern") {
          const alias = definition.node.id.properties.find(
            (p) => p.type === "Property" && p.value.name === input.name,
          );
          return alias && (alias.key.name ?? alias.key.value);
        }
        if (definition?.node.init?.type === "MemberExpression")
          return property(definition.node.init);
      }
    };
    return {
      CallExpression(node) {
        const name = method(node.callee);
        if (name === "Class" && node.arguments[0]) classes(node.arguments[0]);
        if (name === "Style" && node.arguments[0]) styles(node.arguments[0]);
        if (name === "Attribute" && node.arguments.length >= 2) {
          const names = values(node.arguments[0]);
          if (!names) report(node.arguments[0], "unknown", "attribute name");
          else {
            if (names.includes("class")) classes(node.arguments[1]);
            if (names.includes("style")) styles(node.arguments[1]);
          }
        }
      },
      Property(node) {
        const keys = node.computed ? values(node.key) : [node.key.name ?? node.key.value];
        if (keys?.includes("className") || keys?.includes("class")) classes(node.value);
        if (keys?.includes("style")) styles(node.value);
      },
      Program(node) {
        // Oxlint parses TS, not CSS/HTML. Check these owned assets once at the entry
        // so the existing lint:code gate catches new stylesheets and body utilities.
        if (file !== directory + "entry.ts") return;
        for (const path of stylesheets(resolve(root, directory, ".."))) {
          const name = relative(resolve(root, directory), path).replaceAll("\\", "/");
          const source = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
          if (name === "fluid-utilities.css") {
            const remainder = source
              .replace(/@import\s+"tailwindcss"\s+source\("\."\);/g, "")
              .replace(/@theme\s+inline\s*\{[^{}]*\}/g, "")
              .trim();
            if (remainder)
              report(
                node,
                "stylesheet",
                `${name} may declare only Tailwind imports and theme tokens`,
              );
          } else if (!cssExceptions.has(name))
            report(node, "stylesheet", `${name} is not an allowed stylesheet`);
          else if (name === "fonts.css" && source.replace(/@font-face\s*\{[^{}]*\}/g, "").trim())
            report(node, "stylesheet", "fonts.css may declare only font-face rules");
        }
        const html = readFileSync(resolve(root, directory, "../index.html"), "utf8");
        for (const match of html.matchAll(/\bclass=["']([^"']*)["']/g))
          for (const candidate of match[1].split(/\s+/).filter(Boolean))
            if (utilityError(candidate)) report(node, "token", `index.html: ${candidate}`);
        if (/<style\b|\bstyle\s*=/i.test(html))
          report(node, "stylesheet", "index.html must use token utilities, not inline styles");
      },
    };
  },
};
