import { afterEach, describe, expect, test } from "bun:test";
import { EMBED_DIMS, embedConfigFromEnv, embedMaybe, toVectorLiteral } from "../src/embed";

const { LITELLM_URL, EMBEDDING_MODEL } = process.env;
afterEach(() => {
  if (LITELLM_URL === undefined) delete process.env.LITELLM_URL;
  else process.env.LITELLM_URL = LITELLM_URL;
  if (EMBEDDING_MODEL === undefined) delete process.env.EMBEDDING_MODEL;
  else process.env.EMBEDDING_MODEL = EMBEDDING_MODEL;
});

describe("embeddings are optional + gated", () => {
  test("no EMBEDDING_MODEL → config is null → embedMaybe degrades to null", async () => {
    process.env.LITELLM_URL = "http://localhost:4000";
    delete process.env.EMBEDDING_MODEL;
    expect(embedConfigFromEnv()).toBeNull();
    expect(await embedMaybe("anything")).toBeNull();
  });

  test("no LITELLM_URL → config is null", () => {
    delete process.env.LITELLM_URL;
    process.env.EMBEDDING_MODEL = "voyage-3";
    expect(embedConfigFromEnv()).toBeNull();
  });

  test("config resolves when both are set", () => {
    process.env.LITELLM_URL = "http://localhost:4000";
    process.env.EMBEDDING_MODEL = "voyage-3";
    expect(embedConfigFromEnv()).toEqual({
      baseUrl: "http://localhost:4000",
      apiKey: process.env.LITELLM_API_KEY,
      model: "voyage-3",
    });
  });
});

describe("toVectorLiteral", () => {
  test("formats a pgvector literal", () => {
    expect(toVectorLiteral([0.1, 0.2, -0.3])).toBe("[0.1,0.2,-0.3]");
  });
  test("column dimensionality is the contract", () => {
    expect(EMBED_DIMS).toBe(1024);
  });
});
