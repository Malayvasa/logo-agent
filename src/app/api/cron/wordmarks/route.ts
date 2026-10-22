import { NextRequest, NextResponse } from "next/server";
import { requireCron } from "@/lib/auth";
import { runWordmarkCheck } from "@/lib/wordmark-check";

// Daily wordmark check, scheduled in vercel.json. Covers the 24h since the
// previous run, so the schedule and `hours` must stay in step.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const denied = requireCron(request);
  if (denied) return denied;

  try {
    await runWordmarkCheck({ hours: 24, all: false, slugs: [], dryRun: false });
    return NextResponse.json({ status: "ok" });
  } catch (err) {
    console.error("[wordmarks] Failed:", err);
    return NextResponse.json({ error: "Wordmark check failed" }, { status: 500 });
  }
}
