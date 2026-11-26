/**
 * The syntax tree of the pinned TypeScript 7 compiler (`tools/graph-compiler`),
 * whose sync API binds the graph walker's names. Its nodes come from that
 * compiler's program, so this module re-exports its node types and guards and
 * adds the few TypeScript 5 helpers the walker uses that it does not publish.
 */
import {
  SyntaxKind, isClassLikeDeclaration, isModifier, isNoSubstitutionTemplateLiteral, isStringLiteral,
  type ClassLikeDeclaration, type Modifier, type ModifierLike, type Node, type NodeArray,
  type NoSubstitutionTemplateLiteral, type SignatureDeclaration, type StringLiteral,
} from "tsrs/ast";

export * from "tsrs/ast";

export const forEachChild = <T>(node: Node, visit: (child: Node) => T): T | undefined => node.forEachChild(visit);

export const canHaveModifiers = (node: Node): node is Node & { readonly modifiers?: NodeArray<ModifierLike> } =>
  "modifiers" in node;

export const getModifiers = (node: Node): ReadonlyArray<Modifier> | undefined =>
  canHaveModifiers(node) ? node.modifiers?.filter(isModifier) : undefined;

export const isClassLike = (node: Node | undefined): node is ClassLikeDeclaration =>
  node !== undefined && isClassLikeDeclaration(node);

export const isStringLiteralLike = (node: Node): node is StringLiteral | NoSubstitutionTemplateLiteral =>
  isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node);

// TypeScript 5's `isFunctionLike`: declarations and signatures that have parameters.
const functionLike = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration, SyntaxKind.MethodDeclaration, SyntaxKind.Constructor, SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor, SyntaxKind.FunctionExpression, SyntaxKind.ArrowFunction, SyntaxKind.MethodSignature,
  SyntaxKind.CallSignature, SyntaxKind.JSDocSignature, SyntaxKind.ConstructSignature, SyntaxKind.IndexSignature,
  SyntaxKind.FunctionType, SyntaxKind.ConstructorType,
]);
export const isFunctionLike = (node: Node | undefined): node is SignatureDeclaration =>
  node !== undefined && functionLike.has(node.kind);

export const findAncestor = (node: Node | undefined, match: (node: Node) => boolean): Node | undefined => {
  for (let at = node; at; at = at.parent) if (match(at)) return at;
  return undefined;
};
