import { NextResponse } from "next/server";

type StoreEntry = {
  t: number;
  seq: number;
  sample: unknown;
};

declare global {
  // eslint-disable-next-line no-var
  var __motionStore: Map<string, StoreEntry> | undefined;
}

const store: Map<string, StoreEntry> =
  globalThis.__motionStore ?? new Map<string, StoreEntry>();

globalThis.__motionStore = store;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const session = typeof body?.session === "string" ? body.session : "";
    if (!session) {
      return NextResponse.json(
        { ok: false, error: "Missing session" },
        { status: 400 },
      );
    }

    const prev = store.get(session);
    const entry: StoreEntry = {
      t: Date.now(),
      seq: (prev?.seq ?? 0) + 1,
      sample: body?.sample ?? null,
    };

    store.set(session, entry);
    return NextResponse.json({ ok: true, seq: entry.seq, t: entry.t });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON" },
      { status: 400 },
    );
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const session = searchParams.get("session");
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "Missing session" },
      { status: 400 },
    );
  }

  const entry = store.get(session) ?? null;
  return NextResponse.json({ ok: true, entry });
}
