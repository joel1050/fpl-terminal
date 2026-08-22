import { afterEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/ai/route";

const originalKey = process.env.DEEPSEEK_API_KEY;
const originalModel = process.env.DEEPSEEK_MODEL;

afterEach(() => {
  if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalKey;
  if (originalModel === undefined) delete process.env.DEEPSEEK_MODEL;
  else process.env.DEEPSEEK_MODEL = originalModel;
});

describe("AI status route", () => {
  it("reports offline status without exposing the key", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_MODEL = "custom-model";

    const response = GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ enabled: false, model: "custom-model" });
  });

  it("reports enabled status when a server key exists", async () => {
    process.env.DEEPSEEK_API_KEY = "secret-test-key";
    delete process.env.DEEPSEEK_MODEL;

    const response = GET();
    const payload = await response.json();
    expect(payload).toEqual({ enabled: true, model: "deepseek-v4-flash" });
    expect(JSON.stringify(payload)).not.toContain("secret-test-key");
  });
});
