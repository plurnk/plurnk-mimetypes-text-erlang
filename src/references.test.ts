import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertHandlerConformance } from "@plurnk/plurnk-mimetypes/conformance";
import TextErlang from "./TextErlang.ts";

const metadata = {
    mimetype: "text/x-erlang",
    glyph: "🟥",
    extensions: [".erl", ".hrl"] as const,
};
const h = () => new TextErlang(metadata);

// Realistic Erlang module: a local call graph (start → loop → handle/double),
// remote calls into stdlib (lists:reverse, io:format), and decoys that live
// only in strings/comments so the conformance harness can prove they never
// surface as refs.
const SRC = `-module(server).
-export([start/0]).

% spawn the worker — the word frobnicate must never become a ref
double(N) ->
    N * 2.

handle(Msg, Acc) ->
    Doubled = double(Msg),
    [Doubled | Acc].

loop(State) ->
    receive
        {add, Msg} ->
            New = handle(Msg, State),
            loop(New);
        stop ->
            lists:reverse(State)
    end.

start() ->
    io:format("booting widget~n", []),
    loop([]).
`;

describe("TextErlang — references (call graph)", () => {
    it("local calls resolve to the enclosing function as container", () => {
        const refs = h().references(SRC);
        // handle/2 calls double/1.
        assert.ok(refs.some((r) => r.name === "double" && r.kind === "call" && r.container === "handle"));
        // loop/1 calls handle/2 and recurses on loop/1.
        assert.ok(refs.some((r) => r.name === "handle" && r.kind === "call" && r.container === "loop"));
        assert.ok(refs.some((r) => r.name === "loop" && r.kind === "call" && r.container === "loop"));
        // start/0 calls loop/1.
        assert.ok(refs.some((r) => r.name === "loop" && r.kind === "call" && r.container === "start"));
    });

    it("remote Mod:Fun calls name the function part (honest dead rows)", () => {
        const refs = h().references(SRC);
        assert.ok(refs.some((r) => r.name === "reverse" && r.kind === "call" && r.container === "loop"));
        assert.ok(refs.some((r) => r.name === "format" && r.kind === "call" && r.container === "start"));
        // The module atom of a remote call is NOT a ref.
        assert.ok(!refs.some((r) => r.name === "lists"));
        assert.ok(!refs.some((r) => r.name === "io"));
    });

    it("every ref is a call edge — no definitions leak in", () => {
        const refs = h().references(SRC);
        assert.ok(refs.length > 0);
        assert.ok(refs.every((r) => r.kind === "call"));
    });

    it("passes the SPEC §16 conformance invariants", async () => {
        await assertHandlerConformance(h(), {
            source: SRC,
            decoyNames: ["frobnicate", "widget", "booting", "Msg", "Acc"],
            expectJoins: [
                { refName: "double", container: "handle" },
                { refName: "handle", container: "loop" },
                { refName: "loop", container: "start" },
            ],
            expectRefs: [
                { name: "double", kind: "call" },
                { name: "reverse", kind: "call" },
                { name: "format", kind: "call" },
            ],
        });
    });
});
