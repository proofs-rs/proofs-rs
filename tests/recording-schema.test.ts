import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {z,toolchainSource} from "../src/schemas";
import {recordingSchema} from "../scripts/build-recording-schema.ts";

test("recording schema generator rejects silently lossy regex flags", () => {
  assert.throws(() => recordingSchema(z.string().regex(/case/i)), /regex flags are not portable/);
});

test("source regexes preserve the shared case-insensitive input examples", async () => {
  const cases = JSON.parse(await readFile(new URL("../cli/tests/fixtures/recording-pattern-cases.json",import.meta.url),"utf8"));
  for(const c of cases) assert.equal(toolchainSource.safeParse(c.value).success,c.accept);
});
