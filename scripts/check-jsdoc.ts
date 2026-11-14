/**
 * Fails (exit 1) if a function, method, accessor, constructor or exported class / interface /
 * type alias in `src/` has no JSDoc block. Run with `pnpm check:jsdoc`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * Recursively list the `.ts` files under a directory.
 * @param dir - Directory to walk.
 */
function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...listTsFiles(path));
    } else if (path.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

/**
 * The node whose leading comment should hold the JSDoc for `node`. Arrow functions and function
 * expressions are documented on the variable statement or property that holds them.
 * @param node - A function-like node.
 */
function docTarget(node: ts.Node): ts.Node {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) {
    return node;
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent)) {
    return parent.parent.parent; // declaration -> list -> statement
  }
  return parent;
}

/**
 * Whether a node is something this check requires documentation for.
 * @param node - Any AST node.
 */
function needsDoc(node: ts.Node): boolean {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return true;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    return (
      ts.isVariableDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertyAssignment(parent)
    );
  }
  if (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  ) {
    return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
  }
  return false;
}

/**
 * Whether a JSDoc block (`/** ... *\/`) directly precedes `node`.
 * @param text - Full source text.
 * @param node - Node to inspect.
 */
function hasJsDoc(text: string, node: ts.Node): boolean {
  const ranges = ts.getLeadingCommentRanges(text, node.pos) ?? [];
  return ranges.some((range) => text.startsWith("/**", range.pos));
}

/**
 * Human-readable name for a node, used in the report.
 * @param node - Node to describe.
 */
function describe(node: ts.Node): string {
  const named = node as ts.Node & { name?: ts.Node };
  if (named.name) {
    return named.name.getText();
  }
  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }
  const parent = node.parent;
  return ts.isVariableDeclaration(parent) ? parent.name.getText() : "<anonymous>";
}

const problems: string[] = [];
for (const file of listTsFiles("src")) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true);
  /**
   * Visit a node and its children, recording any that lack documentation.
   * @param node - Node to visit.
   */
  const visit = (node: ts.Node): void => {
    if (needsDoc(node) && !hasJsDoc(text, docTarget(node))) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      problems.push(`${file}:${line + 1}  ${describe(node)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (problems.length > 0) {
  console.error(`Missing JSDoc on ${problems.length} item(s):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("JSDoc check passed");
