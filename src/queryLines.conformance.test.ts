import { describe, it } from "node:test";
import { assertQueryLineConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./TextErlang.ts";

// #41: structural matches carry source-line spans (coverage gate).
const h = new Handler({"mimetype":"text/x-erlang","glyph":"🟥","extensions":[".erl",".hrl"]});

describe("#41 query-line conformance", () => {
    it("every structural match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: "-module(m).\nf() -> ok.\n", dialect: "jsonpath", pattern: "$..*" }]);
    });
});
