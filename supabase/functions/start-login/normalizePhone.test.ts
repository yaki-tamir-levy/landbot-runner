import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import { normalizePhone } from "./index.ts";

Deno.test("normalizePhone - valid cases", () => {
  const cases = [
    ["0544973798", "0544973798"],
    ["054-497-3798", "0544973798"],
    ["054 497 3798", "0544973798"],
    ["+972544973798", "0544973798"],
    ["972544973798", "0544973798"],
    ["00972544973798", "0544973798"],
    ["0972544973798", "0544973798"],
    ["0544973798 ", "0544973798"],
  ];
  for (const [inp, exp] of cases) {
    const got = normalizePhone(inp as string);
    assertEquals(got, exp);
  }
});

Deno.test("normalizePhone - invalid cases", () => {
  const cases = [
    ["036831234", null],
    ["0721234567", null],
    ["05449737", null],
    ["054497379812", null],
    ["", null],
    ["abcdefghij", null],
    ["+15551234567", null],
  ];
  for (const [inp, exp] of cases) {
    const got = normalizePhone(inp as string);
    assertEquals(got, exp);
  }
});
