import { AntlrExtractor, withExtractor } from "@plurnk/plurnk-mimetypes";
import type { ExtractionVisitor } from "@plurnk/plurnk-mimetypes";
import { CharStream, CommonTokenStream } from "antlr4ng";
import { ErlangLexer } from "./generated/ErlangLexer.ts";
import { ErlangParser } from "./generated/ErlangParser.ts";
import { ErlangVisitor } from "./generated/ErlangVisitor.ts";

// text/x-erlang handler. ANTLR grammar from grammars-v4/erlang.
//
// Parser entry rule: forms (form+ EOF)
//   form: (attribute | function_) '.'
//   function_: functionClause (';' functionClause)*
//   functionClause: tokAtom clauseArgs clauseGuard clauseBody
//   attribute: '-' tokAtom attrVal | '-' tokAtom typedAttrVal | ...
export default class TextErlang extends AntlrExtractor {
    protected parseTree(content: string): unknown {
        const lexer = new ErlangLexer(CharStream.fromString(content));
        const tokens = new CommonTokenStream(lexer);
        const parser = new ErlangParser(tokens);
        parser.removeErrorListeners();
        return parser.forms();
    }

    protected createVisitor(): ExtractionVisitor {
        return new TextErlangVisitor() as unknown as ExtractionVisitor;
    }
}

// SPEC §3 mapping for Erlang:
//   -module(Name).         → module
//   -record(Name, {...}).  → class (record IS a struct-like type)
//   -type Name(...) :: ... → type
//   functionClause         → function (first clause names the function;
//                            multi-clause definitions share one symbol)
//   -import/-export/-include/etc. → excluded (dependency / metadata)
//
// References (SPEC §16) — the call graph, precision over recall:
//   functionCall: expr800 argumentList; expr800: exprMax (':' exprMax)?
//     local  foo(Args)      → one exprMax    → call(foo),  container = caller fn
//     remote Mod:Fun(Args)  → two exprMax     → call(Fun),  container = caller fn
//   Only atom callees emit. A variable call `F(X)`, an applied fun-expr, or a
//   macro `?M(...)` has no atom name node → no ref (it can't honestly name-join).
//   Remote calls name the function part (`Fun`), not the module — `lists:reverse`
//   emits call(reverse), an honest dead row when no local `reverse/N` exists.
class TextErlangVisitor extends withExtractor(ErlangVisitor) {
    #emittedFunctions = new Set<string>();

    visitAttribute = (ctx: any): null => {
        if (this.inBody) return null;
        // Attribute: '-' tokAtom attrVal | '-' tokAtom typedAttrVal | '-' tokAtom '(' typedAttrVal ')'
        // Discriminate by the attribute name (first tokAtom).
        const atoms = collectChildren(ctx, "tokAtom");
        const head = atoms[0] as { getText?: () => string } | undefined;
        const name = head?.getText?.();
        if (!name) return null;

        switch (name) {
            case "module": {
                // -module(Name).  Name lives in attrVal as another tokAtom.
                const modName = extractAttrAtom(ctx);
                if (modName) this.addSymbol("module", modName, ctx);
                return null;
            }
            case "record": {
                // -record(Name, {...}).  Name is the first tokAtom in attrVal.
                const recName = extractAttrAtom(ctx);
                if (recName) this.addSymbol("class", recName, ctx);
                return null;
            }
            case "type":
            case "opaque": {
                const typeName = extractAttrAtom(ctx);
                if (typeName) this.addSymbol("type", typeName, ctx);
                return null;
            }
            default:
                // export / import / include / behaviour / etc. — excluded.
                return null;
        }
    };

    visitFunction_ = (ctx: any): null => {
        if (this.inBody) return null;
        const clauses = collectChildren(ctx, "functionClause");
        if (clauses.length === 0) return null;
        const first = clauses[0] as {
            tokAtom?: () => { getText?: () => string } | null;
            clauseArgs?: () => unknown;
        };
        const name = first.tokAtom?.()?.getText?.();
        if (!name) return null;

        const params = extractErlangParams(first.clauseArgs?.());
        // Dedupe in case of pathological re-emission.
        const key = `${name}/${params.length}`;
        if (this.#emittedFunctions.has(key)) return null;
        this.#emittedFunctions.add(key);
        this.addSymbol("function", name, ctx, params);
        // Scope the clause bodies so every call site inside carries
        // container = this function (the @> join key, SPEC §16).
        this.gateContainer(name, ctx);
        return null;
    };

    visitFunctionCall = (ctx: any): unknown => {
        // expr800: exprMax (':' exprMax)?  — one part = local, two = remote.
        const e800 = ctx.expr800?.();
        const parts = collectChildren(e800, "exprMax");
        // The callee name node: the function part (last exprMax). For a remote
        // call that's `Fun` in `Mod:Fun`; for a local call it's the sole atom.
        const callee = parts[parts.length - 1];
        const name = atomMaxText(callee);
        if (name) this.addRef("call", name, callee as never);
        // Recurse so nested calls inside the argument list are captured too.
        return this.visitChildren(ctx);
    };
}

// An exprMax names a function only when it is a bare atom (exprMax → atomic →
// tokAtom). Variables, applied fun-expressions, and macros return null and emit
// no ref — precision over recall (SPEC §16).
function atomMaxText(exprMax: unknown): string | null {
    if (!exprMax) return null;
    const atomic = (exprMax as { atomic?: () => unknown }).atomic?.();
    if (!atomic) return null;
    const tokAtom = (atomic as { tokAtom?: () => { getText?: () => string } | null }).tokAtom?.();
    return tokAtom?.getText?.() ?? null;
}

// Find the first tokAtom INSIDE the attribute's value (after the attribute
// name itself). The Erlang grammar wraps the value in a deep expr/expr100/
// expr150/...  chain, so a shallow `tokAtom()` accessor returns only the
// attribute-name atom. Descend through the attrVal subtree looking for the
// first TokAtomContext leaf.
function extractAttrAtom(attrCtx: unknown): string | null {
    const ctx = attrCtx as {
        attrVal?: () => unknown;
        typedAttrVal?: () => { expr?: () => unknown } | null;
    };
    // For `-type` / `-opaque`, the value subtree is `typedAttrVal: expr '::'
    // topType`. The type NAME is the leading atom of the expr (LHS), NOT
    // the topType (which is the right-side definition). For attrVal-shaped
    // values (`-module`, `-record`), walk the whole subtree.
    const tav = ctx.typedAttrVal?.();
    if (tav) {
        const expr = tav.expr?.();
        if (expr) return findFirstTokAtom(expr);
    }
    const av = ctx.attrVal?.();
    if (av) return findFirstTokAtom(av);
    return null;
}

// DFS preorder — walk children in order, finding the first TokAtomContext.
function findFirstTokAtom(root: unknown): string | null {
    const stack: unknown[] = [root];
    while (stack.length > 0) {
        const node = stack.pop() as {
            constructor?: { name?: string };
            getText?: () => string;
            getChildCount?: () => number;
            getChild?: (i: number) => unknown;
        };
        if (!node) continue;
        if (node.constructor?.name === "TokAtomContext") {
            return node.getText?.() ?? null;
        }
        const count = node.getChildCount?.() ?? 0;
        // Push in reverse so we visit children left-to-right.
        for (let i = count - 1; i >= 0; i -= 1) stack.push(node.getChild?.(i));
    }
    return null;
}

// clauseArgs: patArgumentList
// patArgumentList: '(' patExprs? ')'
// patExprs: patExpr (',' patExpr)*
// We surface each patExpr's text as a "parameter name" — Erlang's patterns
// can be arbitrarily complex (bound variables, atoms, tuples), but for
// outline purposes the textual representation is honest about what the
// function clause matches.
function extractErlangParams(clauseArgs: unknown): string[] {
    if (!clauseArgs) return [];
    const node = clauseArgs as { patArgumentList?: () => unknown };
    const pal = node.patArgumentList?.();
    if (!pal) return [];
    const palNode = pal as { patExprs?: () => unknown };
    const patExprs = palNode.patExprs?.();
    if (!patExprs) return [];
    const peNode = patExprs as { patExpr?: () => Array<unknown> | unknown };
    const raw = peNode.patExpr?.();
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const out: string[] = [];
    for (const p of arr) {
        const t = (p as { getText?: () => string }).getText?.();
        if (t) out.push(t);
    }
    return out;
}

function collectChildren(ctx: unknown, methodName: string): unknown[] {
    const node = ctx as Record<string, unknown>;
    const accessor = node[methodName] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof accessor !== "function") return [];
    const raw = accessor.call(node);
    if (Array.isArray(raw)) return raw;
    return raw ? [raw] : [];
}
