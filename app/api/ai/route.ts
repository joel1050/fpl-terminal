import { NextResponse } from "next/server";

import { runAnalyst } from "@/lib/ai/agent";
import { DeepSeekRequestError, getDeepSeekModel, hasDeepSeekKey } from "@/lib/ai/deepseek";
import { AIRequestSchema } from "@/lib/ai/schemas";
import { createFplToolAdapters } from "@/lib/ai/tools";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({ enabled: hasDeepSeekKey(), model: getDeepSeekModel() });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const parsed = AIRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid AI request", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await runAnalyst(parsed.data, { adapters: createFplToolAdapters() });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof DeepSeekRequestError) {
      return NextResponse.json({ error: "DeepSeek request failed", status: error.status }, { status: 502 });
    }
    console.error("AI analyst request failed", error);
    return NextResponse.json({ error: "AI analyst unavailable" }, { status: 500 });
  }
}
