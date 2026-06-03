import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextErlang from "./TextErlang.ts";

const metadata = {
    mimetype: "text/x-erlang",
    glyph: "🟥",
    extensions: [".erl", ".hrl"] as const,
};

describe("TextErlang — instantiation", () => {
    it("instantiates with metadata", () => {
        const h = new TextErlang(metadata);
        assert.equal(h.mimetype, "text/x-erlang");
        assert.equal(h.glyph, "🟥");
    });
});

describe("TextErlang — extract", () => {
    it("extracts -module attribute as module kind", () => {
        const h = new TextErlang(metadata);
        const src = [
            "-module(my_app).",
            "-export([go/0]).",
            "go() -> ok.",
        ].join("\n");
        const syms = h.extractRaw(src);
        const m = syms.find((s) => s.name === "my_app");
        assert.ok(m);
        assert.equal(m.kind, "module");
    });

    it("extracts functions with parameters", () => {
        const h = new TextErlang(metadata);
        const src = [
            "-module(math_utils).",
            "add(A, B) -> A + B.",
            "double(X) -> X * 2.",
        ].join("\n");
        const syms = h.extractRaw(src);
        const add = syms.find((s) => s.name === "add");
        assert.ok(add);
        assert.equal(add.kind, "function");
        assert.deepEqual(add.params, ["A", "B"]);
        const dbl = syms.find((s) => s.name === "double");
        assert.ok(dbl);
        assert.deepEqual(dbl.params, ["X"]);
    });

    it("extracts multi-clause functions as a single symbol", () => {
        const h = new TextErlang(metadata);
        const src = [
            "-module(stack).",
            "pop([]) -> empty;",
            "pop([H|T]) -> {H, T}.",
        ].join("\n");
        const syms = h.extractRaw(src);
        const pops = syms.filter((s) => s.name === "pop");
        assert.equal(pops.length, 1, "multi-clause function should surface once");
    });

    it("extracts zero-arity functions", () => {
        const h = new TextErlang(metadata);
        const src = [
            "-module(app).",
            "start() -> ok.",
        ].join("\n");
        const syms = h.extractRaw(src);
        const start = syms.find((s) => s.name === "start");
        assert.ok(start);
        assert.deepEqual(start.params, []);
    });

    it("extracts -record as class kind", () => {
        const h = new TextErlang(metadata);
        const src = [
            "-module(geo).",
            "-record(point, {x, y}).",
            "origin() -> #point{x=0, y=0}.",
        ].join("\n");
        const syms = h.extractRaw(src);
        const pt = syms.find((s) => s.name === "point");
        assert.ok(pt);
        assert.equal(pt.kind, "class");
    });

    it("extracts -type / -opaque as type kind", () => {
        const h = new TextErlang(metadata);
        const src = [
            "-module(types).",
            "-type maybe_int() :: integer() | undefined.",
            "-opaque handle() :: reference().",
        ].join("\n");
        const syms = h.extractRaw(src);
        const m = syms.find((s) => s.name === "maybe_int");
        assert.ok(m);
        assert.equal(m.kind, "type");
        const hnd = syms.find((s) => s.name === "handle");
        assert.ok(hnd);
        assert.equal(hnd.kind, "type");
    });

    it("excludes -export and -import attributes (SPEC §3)", () => {
        const h = new TextErlang(metadata);
        const src = [
            "-module(app).",
            "-export([go/0, stop/0]).",
            "-import(lists, [reverse/1, map/2]).",
            "go() -> ok.",
            "stop() -> ok.",
        ].join("\n");
        const syms = h.extractRaw(src);
        const names = syms.map((s) => s.name).toSorted();
        assert.deepEqual(names, ["app", "go", "stop"]);
    });

    it("returns empty array for empty input", () => {
        const h = new TextErlang(metadata);
        assert.deepEqual(h.extractRaw(""), []);
    });

    it("does not throw on malformed source (graceful)", () => {
        const h = new TextErlang(metadata);
        assert.doesNotThrow(() => h.extractRaw("foo( broken"));
        assert.doesNotThrow(() => h.extractRaw("@@ totally bogus"));
    });
});

describe("TextErlang — framework integration", () => {
    it("renders extracted hierarchy via format()", async () => {
        const h = new TextErlang(metadata);
        const out = await h.symbolsRaw("-module(m).\nanswer() -> 42.");
        assert.ok(out.includes("function answer"));
    });

    it("jsonpath dispatches against the deep-json ANTLR parse tree (issue #10)", async () => {
        // Every ANTLR deep tree has a root with a `type` field — verify
        // jsonpath reaches it via the deep-channel dispatch.
        const h = new TextErlang(metadata);
        const roots = await h.query("class Probe {}", "jsonpath", "$.type");
        assert.equal(roots.length, 1);
        assert.equal(typeof roots[0].matched, "string");
    });
});

// Real-world smoke against a representative Erlang OTP-style server.
describe("TextErlang — real-world smoke (gen_server-shape)", () => {
    const SRC = [
        "-module(counter_server).",
        "-behaviour(gen_server).",
        "",
        "-export([start_link/0, increment/0, get/0]).",
        "-export([init/1, handle_call/3, handle_cast/2]).",
        "",
        "-record(state, {value = 0}).",
        "",
        "-type counter() :: non_neg_integer().",
        "",
        "start_link() ->",
        "    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).",
        "",
        "increment() ->",
        "    gen_server:cast(?MODULE, increment).",
        "",
        "get() ->",
        "    gen_server:call(?MODULE, get).",
        "",
        "init([]) ->",
        "    {ok, #state{}}.",
        "",
        "handle_call(get, _From, State) ->",
        "    {reply, State#state.value, State}.",
        "",
        "handle_cast(increment, State) ->",
        "    {noreply, State#state{value = State#state.value + 1}}.",
    ].join("\n");

    it("surfaces module, record, type, and functions", () => {
        const h = new TextErlang(metadata);
        const syms = h.extractRaw(SRC);
        const names = new Set(syms.map((s) => s.name));
        assert.ok(names.has("counter_server"));
        assert.ok(names.has("state"));
        assert.ok(names.has("counter"));
        assert.ok(names.has("start_link"));
        assert.ok(names.has("increment"));
        assert.ok(names.has("get"));
        assert.ok(names.has("init"));
        assert.ok(names.has("handle_call"));
        assert.ok(names.has("handle_cast"));
    });

    it("kind discrimination across the file", () => {
        const h = new TextErlang(metadata);
        const syms = h.extractRaw(SRC);
        const byNameKind = new Map(syms.map((s) => [`${s.name}:${s.kind}`, s]));
        assert.ok(byNameKind.has("counter_server:module"));
        assert.ok(byNameKind.has("state:class"));
        assert.ok(byNameKind.has("counter:type"));
        assert.ok(byNameKind.has("start_link:function"));
        assert.ok(byNameKind.has("handle_call:function"));
    });
});
