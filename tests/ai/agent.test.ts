import { afterEach, describe, expect, it } from "vitest";

import { runAnalyst } from "@/lib/ai/agent";
import type { AnalystChatRequest } from "@/lib/ai/agent";

const oldKey = process.env.DEEPSEEK_API_KEY;

afterEach(() => {
  if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = oldKey;
});

describe("FPL analyst", () => {
  it("returns a useful offline response without an API key", async () => {
    delete process.env.DEEPSEEK_API_KEY;

    const result = await runAnalyst({ message: "Who is my weakest player?" });

    expect(result.offline).toBe(true);
    expect(result.message).toContain("AI ANALYST OFFLINE");
    expect(result.message).toContain("DEEPSEEK_API_KEY");
  });

  it("stops a tool loop at MAX_TOOL_ROUNDS", async () => {
    const calls: AnalystChatRequest[] = [];
    const chat = async (request: AnalystChatRequest) => {
      calls.push(request);
      return {
        model: "deepseek-v4-flash",
        choices: [
          {
            message: {
              role: "assistant" as const,
              content: null,
              reasoning_content: "private reasoning",
              tool_calls: [
                {
                  id: `call-${calls.length}`,
                  type: "function" as const,
                  function: { name: "analyze_squad", arguments: "{}" },
                },
              ],
            },
          },
        ],
      };
    };

    const result = await runAnalyst({ message: "Analyze this squad", mode: "thinking" }, { chat, apiKey: "test" });

    expect(result.loopGuardTriggered).toBe(true);
    expect(result.toolRounds).toBe(6);
    expect(calls).toHaveLength(6);
  });

  it("preserves reasoning_content on the next tool turn without returning it", async () => {
    const calls: AnalystChatRequest[] = [];
    const chat = async (request: AnalystChatRequest) => {
      calls.push(request);
      if (calls.length === 1) {
        return {
          choices: [
            {
              message: {
                role: "assistant" as const,
                content: null,
                reasoning_content: "private reasoning that must not be shown",
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function" as const,
                    function: { name: "analyze_squad", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        };
      }
      return { choices: [{ message: { role: "assistant" as const, content: "The squad is balanced." } }] };
    };

    const result = await runAnalyst({ message: "Analyze this squad", mode: "thinking" }, { chat, apiKey: "test" });
    const assistantTurn = calls[1].messages.find((message) => message.role === "assistant");

    expect(assistantTurn?.reasoning_content).toBe("private reasoning that must not be shown");
    expect(result.message).toBe("The squad is balanced.");
    expect(JSON.stringify(result)).not.toContain("private reasoning");
  });
});
